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
use maka_agent_api::contract::WorkspaceAccess;

async fn update_permissions(
    rig: &Rig,
    session: &str,
    expected_revision: u64,
    access: WorkspaceAccess,
    request_permissions: bool,
    revoke_grants: bool,
) -> TestResult<Value> {
    let mut call = rig
        .client
        .as_ref()
        .unwrap()
        .call(
            "agent",
            "metadata".into(),
            json!({
                "sessionId":session,
                "expectedRevision":expected_revision,
                "title":"Permission metadata regression",
                "labels":[],
                "permissions":{
                    "settings":{"access":access,"requestPermissions":request_permissions},
                    "revokeGrants":revoke_grants,
                },
            }),
            Attachments::new(),
        )
        .await?;
    call.start().await?;
    assert!(matches!(call.receive().await?, Reply::Prepared { .. }));
    let Reply::Mutation { reply, cleanup } =
        call.confirm(json!({"test":"permission-boundary"})).await?
    else {
        return Err("metadata did not return a mutation receipt".into());
    };
    cleanup?;
    let Receipt::Recorded {
        outcome:
            OperationOutcome::Returned {
                result: OperationResult::Success { value },
            },
        cleanup: OperationCleanup::Confirmed,
    } = &reply.receipt
    else {
        return Err(format!("metadata did not commit: {:?}", reply.receipt).into());
    };
    let value = value.clone();
    call.close().await?;
    Ok(value)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn permission_metadata_preserves_boundary_and_checks_idle_before_enabling_requests() {
    let mut rig = Rig::new().unwrap();
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(60), async {
        let session = rig.start().await?;
        let owner = rig.captured.lock().unwrap().clone().unwrap();
        let mut previous = owner.mutable_session(&session).await?;
        let initial = previous.configuration.permissions.clone();
        let changed_access = match initial.access {
            WorkspaceAccess::ReadOnly => WorkspaceAccess::WorkspaceWrite,
            WorkspaceAccess::WorkspaceWrite | WorkspaceAccess::DangerFullAccess => {
                WorkspaceAccess::ReadOnly
            }
        };
        for (access, requests, revoke, preserves_basis) in [
            (initial.access, !initial.request_permissions, false, true),
            (initial.access, initial.request_permissions, false, true),
            (changed_access, false, false, false),
            (changed_access, false, true, false),
        ] {
            let result =
                update_permissions(&rig, &session, previous.revision, access, requests, revoke)
                    .await?;
            assert_eq!(result["kind"], "committed", "metadata mutation: {result}");
            let current = owner.mutable_session(&session).await?;
            assert_eq!(
                serde_json::to_value(&current.configuration.permissions)?,
                json!({"access":access,"requestPermissions":requests}),
            );
            assert_eq!(
                current.configuration.permission_basis()
                    == previous.configuration.permission_basis(),
                preserves_basis,
                "permission basis after access={access:?}, requests={requests}, revoke={revoke}",
            );
            previous = current;
        }
        let enabled = update_permissions(
            &rig,
            &session,
            previous.revision,
            changed_access,
            true,
            false,
        )
        .await?;
        assert_eq!(
            enabled["kind"], "committed",
            "enabling while idle: {enabled}"
        );
        let enabled = owner.mutable_session(&session).await?;
        assert_eq!(
            enabled.configuration.permission_basis(),
            previous.configuration.permission_basis()
        );

        rig.assemble(&session).await?;
        let disabled = update_permissions(
            &rig,
            &session,
            enabled.revision,
            changed_access,
            false,
            false,
        )
        .await?;
        assert_eq!(
            disabled["kind"], "committed",
            "disabling while active: {disabled}"
        );
        let disabled = owner.mutable_session(&session).await?;
        assert!(!disabled.configuration.permissions.request_permissions);
        assert_eq!(
            disabled.configuration.permission_basis(),
            enabled.configuration.permission_basis()
        );

        let rejected = update_permissions(
            &rig,
            &session,
            disabled.revision,
            changed_access,
            true,
            false,
        )
        .await?;
        assert_eq!(rejected, json!({"kind":"rejected","reason":"busy"}));
        let unchanged = owner.mutable_session(&session).await?;
        assert_eq!(unchanged.revision, disabled.revision);
        assert!(!unchanged.configuration.permissions.request_permissions);
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = rig.finish().await;
    assert!(
        matches!(&outcome, Ok(Ok(Ok(())))),
        "permission metadata regression: {outcome:?}"
    );
    assert!(
        cleanup.is_empty(),
        "permission metadata fixture cleanup: {cleanup:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retained_computer_preview_survives_accepted_input_but_not_stop() {
    retained_preview_after_input(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retained_computer_preview_released_run_is_not_a_persistence_failure() {
    retained_preview_after_input(false).await;
}

async fn retained_preview_after_input(stop: bool) {
    use crate::owner::access::preview_fixture;
    use maka_agent_facts::tool_call::{ToolCallIdentity, ToolOrigin};
    use maka_agent_facts::tools::ToolCallContext;

    use maka_agent_facts::tool_output::{AcceptedToolResult, DurableToolProjection};

    let mut rig = Rig::new().unwrap();
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(60), async {
        let session = rig.start().await?;
        let owner = rig.captured.lock().unwrap().clone().unwrap();
        let current = owner.mutable_session(&session).await?;
        let result = update_permissions(
            &rig,
            &session,
            current.revision,
            WorkspaceAccess::DangerFullAccess,
            false,
            false,
        )
        .await?;
        assert_eq!(result["kind"], "committed");
        rig.assemble(&session).await?;
        let attempt = rig.attempt().await?;
        let (key, _) = rig
            .tool(attempt, "cua_repl", "preview-input", json!({}))
            .await?;
        let driver = rig.driver.as_ref().unwrap();
        let execution = driver.access.execution().clone();
        let before = driver.state.frontier(execution.run_id).await?;
        let context = ToolCallContext {
            execution: execution.clone(),
            operation_id: format!("{}:{}", key.attempt, key.call),
            call: ToolCallIdentity {
                tool_call_id: key.call.clone(),
                origin: ToolOrigin::Provider {
                    link: AgentStepLink {
                        run: execution.run_id,
                        step: before.attempts[&attempt].step,
                        attempt,
                    },
                },
            },
            custody: Some(driver.access.custody().clone()),
        };
        // Logical Host-bound state, not a physical dispatch/receipt claim.
        let original = serde_json::from_value(json!({
            "source":{"stateDomain":"a".repeat(64),"deployment":Uuid::new_v4(),"revision":1},
            "namespace":[Uuid::new_v4()], "export":"computer","method":"evaluate",
            "operation":Uuid::new_v4(),"fingerprint":format!("sha256-{}", "a".repeat(64)),
            "contract":{"name":"maka.workspace.Computer","version":1,"transport":"remote",
                "digest":format!("sha256-{}", "b".repeat(64))},
            "recovery":"journal_v1"
        }))?;
        let input = preview_fixture(driver.access.clone(), context, original).await?;
        let basis = input.current().await?.permission_basis();
        let preview = input.retain_preview(&basis).await?;
        let target = maka_workspace_api::computer::target();
        preview.granted(&target).await?;

        let returned = ContentBlob::json(&ToolReturn {
            schema_version: SCHEMA_VERSION,
            artifacts: vec![],
            body: ReturnedToolResult {
                output: ToolOutput::Json(json!({"done":true})),
                projection: DurableToolProjection::Json {
                    value: json!({"done":true}),
                },
                is_error: false,
                loaded_tools: Default::default(),
            },
        })?;
        let accepted = ContentBlob::json(&AcceptedToolResult::Local {
            result: returned.reference().clone(),
        })?;
        rig.append(
            vec![
                Fact::LocalToolReturned {
                    tool: key.clone(),
                    settlement: ToolSettlement::Returned,
                    result: returned.reference().clone(),
                    is_error: false,
                    cell_observation: None,
                },
                Fact::ToolResultAccepted {
                    tool: key,
                    result: accepted.reference().clone(),
                    outcome: AcceptedResult::Succeeded,
                },
            ],
            vec![returned, accepted],
        )
        .await?;
        let active = driver.access.fresh().await?;
        assert!(!active.stopped && active.terminal.is_none());
        assert_eq!(active.run, execution.run_id);
        assert_eq!(active.current_attempt, Some(attempt));
        // Accepted tools leave the hot frontier; rejection need not name settlement.
        let input_current = input.current().await.map(|_| ());
        assert!(
            matches!(&input_current, Err(ToolError::Failed(_))),
            "Accepted input remained usable: {input_current:?}",
        );
        assert!(
            input.retain_preview(&basis).await.is_err(),
            "Settled input minted new read authority"
        );
        input.run_current().await?;
        let revision = driver.state.frontier(execution.run_id).await?.revision;
        for _ in 0..3 {
            preview.granted(&target).await?;
            preview.native_current().await?;
        }
        assert_eq!(
            driver.state.frontier(execution.run_id).await?.revision,
            revision,
            "Read-only preview appended durable facts"
        );

        if stop {
            rig.append(
                vec![Fact::StopRequested {
                    diagnostic: "preview-stop".into(),
                }],
                vec![],
            )
            .await?;
            assert!(input.run_current().await.is_err());
            assert!(
                preview.current().await.is_err(),
                "Old preview survived Stop"
            );
            assert!(preview.granted(&target).await.is_err());
        }

        rig.lease.take().unwrap().finish();
        let retired = preview.current().await.map(|_| ());
        assert!(
            matches!(&retired, Err(ToolError::Failed(message)) if message == "Computer preview Run retired"),
            "Released Run work was not ordinary preview retirement: {retired:?}",
        );
        assert!(matches!(preview.granted(&target).await, Err(ToolError::Failed(_))));
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = rig.finish().await;
    assert!(
        matches!(&outcome, Ok(Ok(Ok(())))),
        "retained preview regression: {outcome:?}"
    );
    assert!(cleanup.is_empty(), "preview fixture cleanup: {cleanup:?}");
}

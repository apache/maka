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

async fn commit_mutation(rig: &Rig, method: &str, input: Value) -> TestResult<Value> {
    let mut call = rig
        .client
        .as_ref()
        .unwrap()
        .call("agent", method.into(), input, Attachments::new())
        .await?;
    call.start().await?;
    assert!(matches!(call.receive().await?, Reply::Prepared { .. }));
    let Reply::Mutation { reply, cleanup } =
        call.confirm(json!({"test":"permission-boundary"})).await?
    else {
        return Err(format!("{method} did not return a mutation receipt").into());
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
        return Err(format!("{method} did not commit: {:?}", reply.receipt).into());
    };
    let value = value.clone();
    call.close().await?;
    Ok(value)
}

async fn update_permissions(
    rig: &Rig,
    session: &str,
    expected_revision: u64,
    access: WorkspaceAccess,
    request_permissions: bool,
    revoke_grants: bool,
) -> TestResult<Value> {
    commit_mutation(
        rig,
        "metadata",
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
    )
    .await
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
                display_budget_chars: None,
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
        let producer = maka_computer_use::ExecutionCorrelation::new(execution.run_id.to_string()).unwrap();
        let other = maka_computer_use::ExecutionCorrelation::new("another-execution").unwrap();
        assert!(matches!(preview.native_current(&other).await, Err(ToolError::Failed(_))));
        for _ in 0..3 {
            preview.granted(&target).await?;
            preview.native_current(&producer).await?;
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
                    requester: maka_agent_facts::durable::StopRequester::Internal,
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

#[tokio::test]
async fn external_host_tools_respect_session_sandbox() -> TestResult<()> {
    use maka_agent_facts::{
        cells::{CellId, CellOwner},
        external_effects::ExternalEffectKey,
        tool_call::ToolOrigin,
    };
    use maka_sandbox::{Sandbox, filesystem::Access};

    for mode in [
        WorkspaceAccess::DangerFullAccess,
        WorkspaceAccess::WorkspaceWrite,
    ] {
        let mut rig = Rig::new()?;
        let result = async {
            let session = rig
                .start_configured(None, |config| {
                    config["external"] = json!({"runtimes":{"codex":true}});
                })
                .await?;
            let owner = rig.captured.lock().unwrap().clone().unwrap();
            let revision = owner.mutable_session(&session).await?.revision;
            let update = update_permissions(&rig, &session, revision, mode, false, false).await?;
            assert_eq!(update["kind"], "committed", "{update}");
            let budget = Budget {
                tokens: None,
                retries: 0,
                deadline: None,
            };
            rig.assemble_backend(&session, budget, false, true).await?;
            let access = &rig.driver.as_ref().unwrap().access;
            let run = access.execution().run_id;
            let key = ExternalEffectKey {
                task: ExternalTaskId::new(),
                operation: Uuid::new_v4(),
            };
            let direct = ToolOrigin::External {
                task: key.task,
                operation: key.operation,
                package_id: "maka.agent".into(),
                entry_id: "maka.agent".into(),
                activation: "fixture".into(),
            };
            let nested = ToolOrigin::CodeCell {
                cell: CellId::for_external(run, key),
                owner: CellOwner::External { run, key },
                parent_operation_id: "exec".into(),
                parent_tool_call_id: "exec".into(),
            };
            Ok::<_, Box<dyn Error + Send + Sync>>([
                access.sandbox_floor(&direct).await?,
                access.sandbox_floor(&nested).await?,
            ])
        }
        .await;
        let cleanup = rig.finish().await;
        assert!(cleanup.is_empty(), "{cleanup:?}");
        for floor in result? {
            if mode == WorkspaceAccess::DangerFullAccess {
                assert_eq!(floor, Sandbox::Disabled);
            } else {
                let Sandbox::Managed { filesystem, .. } = floor else {
                    panic!("expected the workspace sandbox, got {floor:?}");
                };
                assert_eq!(
                    filesystem
                        .compile()?
                        .access(&maka_sandbox::native_task_namespace()?),
                    Access::Deny
                );
            }
        }
    }
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fork_keeps_parent_permissions_for_user_and_caps_agent_caller() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(60), async {
        // Rig configures installation settings.permissions as ReadOnly / requestPermissions=false.
        let parent_id = rig.start().await?;
        let owner = rig.captured.lock().unwrap().clone().unwrap();
        let parent = owner.mutable_session(&parent_id).await?;
        let full_access = WorkspacePermissions {
            access: WorkspaceAccess::DangerFullAccess,
            request_permissions: true,
        };
        let upgraded = update_permissions(
            &rig,
            &parent_id,
            parent.revision,
            full_access.access,
            full_access.request_permissions,
            false,
        )
        .await?;
        assert_eq!(upgraded["kind"], "committed", "{upgraded}");
        let parent = owner.mutable_session(&parent_id).await?;

        let user_fork = commit_mutation(
            &rig,
            "fork",
            json!({
                "sessionId": parent_id,
                "expectedRevision": parent.revision,
                "position": {"kind": "end"},
                "title": "User side question",
                "labels": [],
                "side": true,
            }),
        )
        .await?;
        assert_eq!(user_fork["kind"], "forked", "{user_fork}");
        let user_fork_id = user_fork["session"]["id"]
            .as_str()
            .ok_or("user fork id missing")?;
        let user_fork_session = owner.mutable_session(user_fork_id).await?;
        assert_eq!(user_fork_session.configuration.permissions, full_access);
        assert_eq!(user_fork_session.configuration.parent_session_id, None);

        let caller_created = commit_mutation(
            &rig,
            "create",
            json!({
                "title": "Lower-privileged agent caller",
                "labels": [],
                "workspace": {"kind": "directory", "path": rig.directory.path().join("workspace")},
            }),
        )
        .await?;
        assert_eq!(caller_created["kind"], "created", "{caller_created}");
        let caller_id = caller_created["session"]["id"]
            .as_str()
            .ok_or("caller session id missing")?
            .to_owned();
        let caller = owner.mutable_session(&caller_id).await?;
        let caller_ceiling = WorkspacePermissions {
            access: WorkspaceAccess::WorkspaceWrite,
            request_permissions: false,
        };
        let caller_updated = update_permissions(
            &rig,
            &caller_id,
            caller.revision,
            caller_ceiling.access,
            caller_ceiling.request_permissions,
            false,
        )
        .await?;
        assert_eq!(caller_updated["kind"], "committed", "{caller_updated}");

        rig.assemble(&caller_id).await?;
        let driver = rig.driver.as_ref().unwrap();
        let target = maka_plugin_core::contract::ServiceTarget::Export {
            name: "agent".into(),
        };
        let request = owner
            .services
            .select_method(&target, "sessionCreate")?
            .request_with_work(
                maka_capabilities::call::Identity::Agent {
                    execution: driver.access.execution().clone(),
                    operation_id: None,
                },
                CancellationToken::new(),
                driver.access.custody().clone(),
            )?;
        let completed = request
            .begin_mutation_target(
                &target,
                "sessionCreate".into(),
                json!({
                    "title": "Agent fork of full-access session",
                    "forkFrom": {"sessionId": parent_id, "expectedRevision": parent.revision},
                }),
                Uuid::new_v4(),
                json!({"test": "agent-fork-ceiling"}),
                Attachments::new(),
            )?
            .await?
            .completion()
            .await;
        completed.cleanup?;
        request.finish().await?;
        let Receipt::Recorded {
            outcome:
                OperationOutcome::Returned {
                    result: OperationResult::Success { value: agent_fork },
                },
            cleanup: OperationCleanup::Confirmed,
        } = completed.reply.receipt
        else {
            return Err(format!("agent fork did not commit: {:?}", completed.reply.receipt).into());
        };
        assert_eq!(agent_fork["kind"], "forked", "{agent_fork}");
        let agent_fork_id = agent_fork["session"]["id"]
            .as_str()
            .ok_or("agent fork id missing")?;
        let agent_fork_session = owner.mutable_session(agent_fork_id).await?;
        assert_eq!(agent_fork_session.configuration.permissions, caller_ceiling);
        assert_eq!(
            agent_fork_session
                .configuration
                .parent_session_id
                .as_deref(),
            Some(caller_id.as_str())
        );
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = rig.finish().await;
    assert!(
        matches!(&outcome, Ok(Ok(Ok(())))),
        "fork permissions regression: {outcome:?}"
    );
    assert!(
        cleanup.is_empty(),
        "fork permissions fixture cleanup: {cleanup:?}"
    );
    Ok(())
}

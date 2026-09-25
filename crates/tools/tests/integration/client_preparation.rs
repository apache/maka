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

use maka_client_capability::{
    BindingMode, Endpoint, Identity, PrincipalKind, Registry, broker::Broker,
};
use maka_event_log::EventLog;
use maka_js_runtime::{CellLimits, CodeExecutor};
use maka_runtime::{
    capability::{AdmissionEvidence, CallResult, ClientFrame, HostFrame},
    event::Fact,
    execution::{BehaviorId, CollaborationMode, InvocationConfiguration, SandboxMode, ToolMode},
    interaction::GrantTarget,
    model::ModelToolCall,
    tool_call::{ToolOrigin, ToolRejection},
    tools::ToolError,
};
use maka_tools::{
    ApprovalFuture, ClientInteractions, ClientTools, RunTools, ToolCallContext, ToolCatalog,
};
use serde_json::json;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::support::model_fixture;

const TOOL: &str = "mcp__client__effect";

struct Approval {
    mode: SandboxMode,
    requests: tokio::sync::mpsc::UnboundedSender<(
        GrantTarget,
        ToolCallContext,
        CancellationToken,
        CancellationToken,
        tokio::sync::oneshot::Sender<bool>,
    )>,
}
impl ClientInteractions for Approval {
    fn sandbox_mode(&self, _: ToolCallContext) -> maka_tools::PermissionFuture {
        let mode = self.mode;
        Box::pin(async move { Ok(mode) })
    }

    fn form(
        &self,
        _: ToolCallContext,
        _: maka_runtime::capability::FormInput,
        _: CancellationToken,
    ) -> maka_client_capability::broker::FormFuture {
        Box::pin(async {
            Err(maka_client_capability::broker::CallError::Invalid(
                "no form consumer in preparation fixture",
            ))
        })
    }

    fn approve(
        &self,
        target: GrantTarget,
        context: ToolCallContext,
        cancellation: CancellationToken,
        provider: CancellationToken,
    ) -> ApprovalFuture {
        let (reply, result) = tokio::sync::oneshot::channel();
        self.requests
            .send((target, context, cancellation, provider, reply))
            .unwrap();
        Box::pin(async move {
            if result.await.unwrap() {
                Ok(())
            } else {
                Err(ToolRejection::PolicyDenied {
                    message: "test decision denied".into(),
                })
            }
        })
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Cut {
    Success,
    Denied,
    Rejected,
    Cancelled,
    Lost,
    Interaction,
    ManagedAllow,
    ManagedDeny,
    Settings,
    Explore,
}

#[tokio::test]
async fn direct_and_nested_remote_tools_prepare_before_t1_and_never_settle_unknown_effects() {
    let cells = CodeExecutor::new(1, CellLimits::default()).unwrap();
    for mode in [ToolMode::Direct, ToolMode::CodeMode] {
        for cut in [
            Cut::Success,
            Cut::Denied,
            Cut::Rejected,
            Cut::Cancelled,
            Cut::Lost,
            Cut::Interaction,
            Cut::ManagedAllow,
            Cut::ManagedDeny,
            Cut::Settings,
            Cut::Explore,
        ] {
            tokio::time::timeout(Duration::from_secs(5), run(mode, cut, cells.clone()))
                .await
                .unwrap_or_else(|_| panic!("prepared routing stalled: {mode:?}/{cut:?}"));
        }
    }
}

async fn run(mode: ToolMode, cut: Cut, cells: CodeExecutor) {
    let tool = if cut == Cut::Settings {
        "mcp__desktop_settings__MakaClientSettingsGet"
    } else {
        TOOL
    };
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = Arc::new(EventLog::open(&path).await.unwrap());
    let invocation = model_fixture::invocation();
    let configuration = InvocationConfiguration {
        workspace_origin: maka_runtime::execution::WorkspaceOrigin::Selected,
        approval_policy: maka_runtime::execution::ApprovalPolicy::OnRequest,
        boundary_revision: 0,
        workspace_identity: None,
        system_prompt: None,
        tool_composition: None,
        cwd: directory.path().to_str().unwrap().into(),
        sandbox_mode: if cut == Cut::Explore {
            SandboxMode::ReadOnly
        } else if matches!(
            cut,
            Cut::Success | Cut::Denied | Cut::ManagedAllow | Cut::ManagedDeny | Cut::Settings
        ) {
            SandboxMode::WorkspaceWrite
        } else {
            SandboxMode::DangerFullAccess
        },
        collaboration_mode: CollaborationMode::Agent,
        orchestration_mode: BehaviorId::default(),
        tool_mode: mode,
        model: None,
        thinking_level: None,
    };
    let call = ModelToolCall {
        id: "provider:parent".into(),
        name: if mode == ToolMode::Direct {
            tool.into()
        } else {
            "exec".into()
        },
        input: if mode == ToolMode::Direct {
            json!({})
        } else {
            json!({"code":format!("try {{ text(await tools.{tool}({{}})); }} catch (_) {{ text({{caught:true}}); }}")})
        },
        provider_options: None,
        provider_executed: false,
    };
    model_fixture::record_model_call(&log, &invocation, &configuration, &call).await;
    let registry = Arc::new(Mutex::new(Registry::default()));
    let broker = Arc::new(Broker::default());
    let connection = Uuid::new_v4();
    let (endpoint, mut frames) = Endpoint::channel(16);
    let snapshot = {
        let mut registry = registry.lock().unwrap();
        registry
            .attach(
                connection,
                Identity {
                    principal_kind: PrincipalKind::LocalOwner,
                    principal_id: "owner".into(),
                    client_instance_id: "client".into(),
                    credential_bound_client_instance_id: None,
                    capability_owner: None,
                },
                endpoint.clone(),
            )
            .unwrap();
        let (offer_id, server_id, name) = match cut {
            Cut::ManagedAllow | Cut::ManagedDeny => ("desktop_mcp_client", "client", "effect"),
            Cut::Settings => (
                "desktop_settings",
                "desktop_settings",
                "MakaClientSettingsGet",
            ),
            _ => ("client", "client", "effect"),
        };
        registry.replace(connection,maka_protocol::capability::decode_replace_input(&json!({
            "registrationId":"r","offers":[{"offerId":offer_id,"version":"1","affinity":"session",
                "hostPathAccess":"none","label":"Client","tools":[{"serverId":server_id,"name":name,"inputSchema":{"type":"object"}}]}]
        })).unwrap()).unwrap();
        registry
            .bind_session("session", Some(connection), BindingMode::Strict)
            .unwrap();
        registry.snapshot("session").unwrap()
    };
    let (requests, mut approvals) = tokio::sync::mpsc::unbounded_channel();
    let approval = Arc::new(Approval {
        requests,
        // The successful call uses a grant newer than its immutable Run opening.
        mode: if cut == Cut::Success {
            SandboxMode::DangerFullAccess
        } else {
            configuration.sandbox_mode
        },
    });
    let catalog = ToolCatalog::new(
        ClientTools::new(
            snapshot,
            registry.clone(),
            broker.clone(),
            configuration.cwd,
            approval,
        )
        .registrations(),
    )
    .unwrap();
    let run = RunTools::new(log.clone(), invocation.clone(), catalog, mode, cells);
    let cancellation = CancellationToken::new();
    let cancel = cancellation.clone();
    let execution = tokio::spawn(async move {
        let result = run
            .capture(".", tokio_util::sync::CancellationToken::new())
            .await
            .unwrap()
            .into_step("step")
            .invoke(&call, cancel)
            .await;
        run.shutdown().await?;
        result
    });
    let HostFrame::Call {
        invocation_id: id,
        source:
            maka_runtime::capability::CallSource::Agent {
                session_id,
                turn_id,
            },
        tool_call_id,
        cwd,
        ..
    } = frames.recv().await.unwrap()
    else {
        panic!("expected prepared call")
    };
    assert_eq!(session_id, "session");
    assert_eq!(turn_id, "turn");
    assert_eq!(cwd, None);
    assert!(tool_call_id.starts_with("tool_"));
    assert_ne!(tool_call_id, "provider:parent");
    let prepared = log.prefix(32, 65536).await.unwrap();
    assert!(
        !prepared
            .events
            .iter()
            .any(|e| matches!(&e.event.fact,Fact::ToolDispatched{name,..} if name==tool)),
        "provider parses before durable effect admission"
    );
    if cut == Cut::Rejected {
        broker
            .accept(
                connection,
                ClientFrame::Rejected {
                    invocation_id: id.clone(),
                    message: "provider declined".into(),
                },
            )
            .unwrap();
    } else {
        broker
            .accept(
                connection,
                ClientFrame::Accepted {
                    invocation_id: id.clone(),
                    admission_evidence: AdmissionEvidence::None,
                },
            )
            .unwrap();
        if cut == Cut::Cancelled {
            cancellation.cancel();
        }
    }
    if matches!(cut, Cut::ManagedAllow | Cut::ManagedDeny) {
        let (target, context, cancel_signal, provider_signal, reply) =
            approvals.recv().await.unwrap();
        assert_eq!(target.server_id, "client");
        assert_eq!(target.tool_name, "effect");
        assert_eq!(context.tool_use_id(), tool_call_id);
        assert_eq!(context.invocation, invocation);
        assert!(!cancel_signal.is_cancelled());
        assert!(!provider_signal.is_cancelled());
        assert!(
            !log.prefix(32, 65536)
                .await
                .unwrap()
                .events
                .iter()
                .any(|e| matches!(&e.event.fact, Fact::ToolDispatched{name,..} if name==tool))
        );
        assert!(
            frames.try_recv().is_err(),
            "approval wait must retain accepted call without admit or cancel"
        );
        assert!(
            registry.try_lock().is_ok(),
            "approval never holds registry lock"
        );
        reply.send(cut == Cut::ManagedAllow).unwrap();
    }
    let has_effect = matches!(
        cut,
        Cut::Success | Cut::Lost | Cut::Interaction | Cut::ManagedAllow | Cut::Settings
    );
    if has_effect {
        assert!(
            matches!(frames.recv().await.unwrap(),HostFrame::Admitted{invocation_id} if invocation_id==id)
        );
        let prefix = log.prefix(32, 65536).await.unwrap();
        let event = prefix
            .events
            .iter()
            .find(|e| matches!(&e.event.fact,Fact::ToolDispatched{name,..} if name==tool))
            .unwrap();
        let Fact::ToolDispatched {
            call, operation_id, ..
        } = &event.event.fact
        else {
            unreachable!()
        };
        assert_eq!(
            maka_runtime::tool_call::tool_use_id(
                &event.event.invocation.invocation_id,
                operation_id,
            ),
            tool_call_id
        );
        assert_eq!(
            call.tool_call_id == "provider:parent",
            mode == ToolMode::Direct
        );
        if mode == ToolMode::CodeMode {
            let ToolOrigin::CodeMode {
                parent_operation_id,
                parent_tool_call_id,
            } = &call.origin
            else {
                panic!("nested tool provenance")
            };
            assert!(prefix.events.iter().any(|e| matches!(&e.event.fact,
                Fact::ToolDispatched { operation_id, call, .. } if operation_id == parent_operation_id
                    && call.tool_call_id == *parent_tool_call_id
                    && matches!(&call.origin, ToolOrigin::CodeCell {parent_operation_id,..} if parent_operation_id=="step:provider:parent"))));
        }
        std::fs::write(directory.path().join("effect"), "once").unwrap();
        if cut == Cut::Lost {
            endpoint.close();
        } else if cut == Cut::Interaction {
            broker
                .accept(connection, model_fixture::interaction(&id))
                .unwrap();
        } else {
            broker
                .accept(
                    connection,
                    ClientFrame::Result {
                        invocation_id: id.clone(),
                        result: CallResult {
                            content: vec![],
                            structured_content: Some(json!({"done":true})),
                        },
                    },
                )
                .unwrap();
        }
    }
    let result = execution.await.unwrap();
    if matches!(cut, Cut::Lost | Cut::Interaction) {
        assert!(matches!(result, Err(ToolError::CleanupUnconfirmed(_))));
    }
    if matches!(cut, Cut::Success | Cut::ManagedAllow | Cut::Settings) {
        assert!(result.is_ok());
    }
    let prefix = log.prefix(32, 65536).await.unwrap();
    let dispatched: Vec<_> = prefix
        .events
        .iter()
        .filter_map(|e| match &e.event.fact {
            Fact::ToolDispatched {
                operation_id, name, ..
            } if name == tool => Some(operation_id),
            _ => None,
        })
        .collect();
    assert_eq!(dispatched.len(), usize::from(has_effect));
    if !has_effect {
        let reason = prefix
            .events
            .iter()
            .find_map(|e| match &e.event.fact {
                Fact::ToolRejected { name, reason, .. } if name == tool => Some(reason),
                _ => None,
            })
            .expect("preparation refusal is a committed rejection");
        assert!(matches!(
            (cut, reason),
            (
                Cut::Denied | Cut::ManagedDeny | Cut::Explore,
                ToolRejection::PolicyDenied { .. }
            ) | (Cut::Rejected, ToolRejection::PreparationFailed { .. })
                | (Cut::Cancelled, ToolRejection::Cancelled)
        ));
        while let Ok(frame) = frames.try_recv() {
            assert!(!matches!(frame, HostFrame::Admitted { .. }));
        }
    } else if matches!(cut, Cut::Lost | Cut::Interaction) {
        assert!(
            !prefix
                .events
                .iter()
                .any(|e| matches!(e.event.fact, Fact::ToolSettled { .. })),
            "JS catch must not settle child or parent uncertainty"
        );
        assert!(
            prefix
                .project_invocation("invocation")
                .uncertain_operations
                .contains(dispatched[0])
        );
    }
    assert_eq!(directory.path().join("effect").exists(), has_effect);
    assert!(
        approvals.try_recv().is_err(),
        "settings and bypass do not ask; managed calls ask once"
    );
    broker.shutdown().await;
    registry.lock().unwrap().begin_drain();
    log.shutdown().await.unwrap();
    let reopened = EventLog::open(&path).await.unwrap();
    assert_eq!(
        serde_json::to_value(prefix).unwrap(),
        serde_json::to_value(reopened.prefix(32, 65536).await.unwrap()).unwrap()
    );
    reopened.close().await.unwrap();
}

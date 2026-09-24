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

use super::support::{
    client_probe::ClientFixture,
    message_recovery::{Provider, configure},
    peer::Peer,
};
use futures_util::FutureExt;
use maka_plugins::{
    composition::Scope,
    execution::{CommandError, CreateChild, Progress, Submit},
    fiber::Fiber,
    storage::{Data, Mutation, StoreError},
};
use maka_runtime::event::InvocationOutcome;
use maka_runtime_host::server::{Host, local::LocalListener};
use serde_json::json;
use std::time::Duration;
use tokio_util::sync::CancellationToken;
mod attachments;
mod boundary;
mod import;
mod interaction;
mod messages;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn plugin_retirement_stops_admission_not_accepted_work_and_reactivation_keeps_receipts() {
    tokio::time::timeout(Duration::from_secs(30), scenario())
        .await
        .unwrap();
}

async fn scenario() {
    let fixture = ClientFixture::new("maka-plugin-commands-");
    for args in [
        vec!["init", "--quiet"],
        vec![
            "-c",
            "user.name=Maka test",
            "-c",
            "user.email=test@maka.invalid",
            "commit",
            "--allow-empty",
            "--quiet",
            "-m",
            "base",
        ],
    ] {
        let output = std::process::Command::new("git")
            .current_dir(&fixture.workspace)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let (provider, mut requests) = Provider::controlled().await;
    let model = configure(&fixture, &provider.base_url).await;
    let request = Submit {
        orchestration_mode: None,
        operation_id: "graph:node:attempt".into(),
        session_id: "plugin-session".into(),
        content: "work".into(),
    };
    let mut original = None;
    let mut original_patch = None;
    let mut offered = None;
    let mut queued = None;
    for reopened in [false, true] {
        if reopened {
            import::tighten(&fixture).await;
        }
        let host = Host::open_with_options(
            fixture.owner(),
            None,
            maka_runtime_host::server::HostOptions {
                plugins: native_plugin(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        #[cfg(unix)]
        let endpoint = fixture.workspace.parent().unwrap().join("plugin.sock");
        #[cfg(windows)]
        let endpoint =
            std::path::PathBuf::from(format!(r"\\.\pipe\maka-plugin-{}", uuid::Uuid::new_v4()));
        let stop = CancellationToken::new();
        let cleanup = stop.clone().drop_guard();
        let server = tokio::spawn(
            LocalListener::bind(&endpoint)
                .unwrap()
                .serve(host.clone(), stop.clone()),
        );
        let mut peer = Peer::new(host.clone(), "plugins").await;
        loop {
            let status = peer
                .rpc("plugin.platform.query", json!({"view":"status"}))
                .await;
            assert_eq!(status["ok"], true, "{status}");
            if status["result"]["convergence"] == "converged" {
                break;
            }
            tokio::task::yield_now().await;
        }
        if !reopened {
            let created = peer
                .rpc(
                    "session.create",
                    json!({
                        "sessionId":"plugin-session",
                        "workspace":{"kind":"host_path","path":fixture.workspace},
                        "modelTarget":{"kind":"explicit","connectionId":model.connection_id,
                            "connectionSlug":model.connection_slug,"model":model.model}
                    }),
                )
                .await;
            assert_eq!(created["ok"], true, "{created}");
        }
        boundary::verify(&host, &mut peer, &model, &fixture.workspace, reopened).await;
        let fiber = Fiber::new("graph", "graph", Scope::Profile).unwrap();
        fiber.begin_loading().unwrap();
        let storage = host.plugin_storage(fiber.context()).unwrap();
        if !reopened {
            storage
                .batch(vec![Mutation {
                    key: "graph:plan".into(),
                    expected_revision: None,
                    data: Data::Present(json!({"node":"attempt"})),
                }])
                .await
                .unwrap();
        } else {
            assert_eq!(
                storage
                    .read("graph:plan".into())
                    .await
                    .unwrap()
                    .unwrap()
                    .revision,
                2
            );
        }
        let commands = host
            .authorize_plugin_execution(fiber.context(), &["plugin-session".into()])
            .await
            .unwrap();
        // Initialization can acquire a capability but cannot start formal work.
        assert!(matches!(
            commands.submit(request.clone()).await,
            Err(CommandError::Revoked)
        ));
        fiber.ready().unwrap();
        fiber.publish().unwrap();
        let provision = CreateChild {
            workspace: Some(maka_plugins::execution::ChildWorkspace::IsolatedGit),
            operation_id: "graph:node-session".into(),
            parent_session_id: "plugin-session".into(),
            name: "Worker".into(),
            sandbox_mode: Some(maka_runtime::execution::SandboxMode::ReadOnly),
            bound_tools: Some(
                ["Read", "FinishPlugin"]
                    .into_iter()
                    .map(str::to_owned)
                    .collect(),
            ),
            instructions: Some(
                "Child-specific durable instructions.\nPreserve this second line.".into(),
            ),
            target: Some(maka_plugins::execution::Target::Model {
                model: model.clone(),
                thinking_level: None,
            }),
        };
        let restored = commands.restore_child(provision.clone()).await.unwrap();
        let child = if reopened {
            restored.expect("restore existing child without touching its dirty workspace")
        } else {
            assert!(restored.is_none());
            commands.create_child(provision.clone()).await.unwrap()
        };
        assert!(matches!(
            commands
                .create_child(CreateChild {
                    operation_id: "forbidden-permission-escalation".into(),
                    parent_session_id: child.session_id.clone(),
                    sandbox_mode: Some(maka_runtime::execution::SandboxMode::DangerFullAccess),
                    ..provision.clone()
                })
                .await,
            Err(CommandError::Denied)
        ));
        attachments::verify(&host, &mut peer, commands.clone(), &child.session_id).await;
        let request = Submit {
            session_id: child.session_id.clone(),
            ..request.clone()
        };
        let mut changed_provision = provision.clone();
        changed_provision.name = "different".into();
        assert!(matches!(
            commands.restore_child(changed_provision).await,
            Err(CommandError::Conflict)
        ));
        let mut foreign = request.clone();
        foreign.session_id = "ungranted".into();
        assert!(matches!(
            commands.submit(foreign).await,
            Err(CommandError::Denied)
        ));
        if !reopened {
            let blocked = Submit {
                content: "block".into(),
                ..request.clone()
            };
            assert!(matches!(
                commands.submit(blocked).await,
                Err(CommandError::Invalid(_))
            ));
            assert!(matches!(
                commands.query(request.operation_id.clone()).await,
                Err(CommandError::NotFound)
            ));
        }
        let receipt = commands.submit(request.clone()).await.unwrap();
        if reopened {
            let input = commands
                .input(receipt.invocation.clone())
                .await
                .unwrap()
                .unwrap();
            assert!(input.text.contains("work"));
            assert_eq!(input.text.matches("PUBLIC_INPUT_PREPARED").count(), 1);
            let mut wrong = receipt.invocation.clone();
            wrong.turn_id = "unrelated".into();
            assert!(matches!(
                commands.input(wrong).await,
                Err(CommandError::NotFound)
            ));
            let mut foreign = receipt.invocation.clone();
            foreign.session_id = "ungranted".into();
            assert!(matches!(
                commands.input(foreign).await,
                Err(CommandError::Denied)
            ));
        }
        if reopened {
            assert_eq!(original.as_ref(), Some(&receipt));
            interaction::replay(commands.as_ref(), offered.as_ref().unwrap()).await;
            messages::replay(commands.as_ref(), queued.as_ref().unwrap()).await;
            assert_eq!(
                commands
                    .workspace_patch(request.operation_id.clone())
                    .await
                    .unwrap(),
                original_patch
            );
            assert!(matches!(
                commands
                    .query(request.operation_id.clone())
                    .await
                    .unwrap()
                    .progress,
                Progress::Ended {
                    outcome: InvocationOutcome::Completed
                }
            ));
            assert_eq!(provider.requests.lock().unwrap().len(), 2);
            let mut changed = request.clone();
            changed.content = "different".into();
            assert!(matches!(
                commands.submit(changed).await,
                Err(CommandError::Conflict)
            ));
            fiber
                .shutdown(tokio::time::Instant::now() + Duration::from_secs(1))
                .await
                .unwrap();
        } else {
            original = Some(receipt.clone());
            assert!(matches!(
                commands.workspace_patch(request.operation_id.clone()).await,
                Err(CommandError::Busy)
            ));
            let active = match tokio::time::timeout(Duration::from_secs(5), requests.recv()).await {
                Ok(Some(active)) => active,
                _ => panic!(
                    "provider did not start; observation={:?}",
                    commands.query(request.operation_id.clone()).await
                ),
            };
            assert!(
                active.body["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|message| {
                        message["role"] == "user"
                            && message["content"].as_str().is_some_and(|text| {
                                text.matches("PUBLIC_INPUT_PREPARED").count() == 1
                            })
                    }),
                "public submit must freeze prepared input before acceptance: {}",
                active.body
            );
            queued = Some(messages::admit(commands.as_ref(), receipt.invocation.clone()).await);
            offered = Some(interaction::offer(commands.as_ref(), receipt.invocation.clone()).await);
            let observed = commands
                .read_message(maka_plugins::execution::SessionMessage {
                    session_id: receipt.invocation.session_id.clone(),
                    message_id: receipt.message_id.clone(),
                    cursor: None,
                })
                .await
                .unwrap()
                .unwrap();
            let maka_plugins::execution::MessageState::Delivered { interactions, .. } = observed
            else {
                panic!("accepted input lost its running owner");
            };
            assert_eq!(interactions.len(), 1);
            assert_eq!(
                interactions[0].request_id,
                offered.as_ref().unwrap().1.request_id
            );
            assert!(matches!(
                interactions[0].kind,
                maka_plugins::execution::InteractionKind::Question
            ));
            assert!(
                active.body["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|message| {
                        message["role"] == "system"
                            && message["content"].as_str().is_some_and(|text| {
                                text.contains(provision.instructions.as_ref().unwrap())
                            })
                    })
            );
            assert!(
                storage
                    .batch(vec![Mutation {
                        key: "graph:plan".into(),
                        expected_revision: Some(1),
                        data: Data::Present(json!({"node":"accepted"})),
                    }])
                    .now_or_never()
                    .is_none()
            );
            fiber
                .shutdown(tokio::time::Instant::now() + Duration::from_secs(1))
                .await
                .unwrap();
            assert!(matches!(
                storage.read("graph:plan".into()).await,
                Err(StoreError::Retired)
            ));
            assert!(matches!(
                commands.submit(request.clone()).await,
                Err(CommandError::Revoked)
            ));
            interaction::answer(&mut peer, offered.as_ref().unwrap()).await;
            assert!(
                active.body["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|tool| tool["function"]["name"] == "tool_search")
            );
            active
                .reply
                .send(tool_call(
                    "search",
                    "tool_search",
                    json!({"query":"FinishPlugin"}),
                ))
                .unwrap();
            let next = requests.recv().await.unwrap();
            assert!(
                next.body
                    .to_string()
                    .contains("Keep this accepted steering")
            );
            assert!(
                next.body["tools"].as_array().unwrap().iter().all(|tool| {
                    matches!(
                        tool["function"]["name"].as_str(),
                        Some("Read" | "FinishPlugin" | "tool_search")
                    )
                }),
                "only explicitly bounded native and dynamic tools may be visible"
            );
            assert!(
                next.body["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|tool| tool["function"]["name"] == "FinishPlugin")
            );
            next.reply
                .send(tool_call(
                    "echo",
                    "FinishPlugin",
                    json!({"value":"durable-plugin-output"}),
                ))
                .unwrap();
            let replacement = Fiber::new("graph", "graph", Scope::Profile).unwrap();
            replacement.begin_loading().unwrap();
            replacement.ready().unwrap();
            replacement.publish().unwrap();
            let recovered = host
                .authorize_plugin_execution(replacement.context(), &["plugin-session".into()])
                .await
                .unwrap();
            assert_eq!(
                recovered.restore_child(provision).await.unwrap(),
                Some(child.clone())
            );
            interaction::replay(recovered.as_ref(), offered.as_ref().unwrap()).await;
            messages::replay(recovered.as_ref(), queued.as_ref().unwrap()).await;
            loop {
                let observation = recovered.query(request.operation_id.clone()).await.unwrap();
                if let Progress::Ended { outcome } = observation.progress {
                    assert_eq!(outcome, InvocationOutcome::Completed);
                    let events = recovered
                        .events(
                            request.operation_id.clone(),
                            0,
                            observation.through_sequence,
                        )
                        .await
                        .unwrap();
                    assert!(
                        serde_json::to_string(&events)
                            .unwrap()
                            .contains("durable-plugin-output")
                    );
                    assert!(events.next_after.is_none());
                    let maka_runtime::event::Fact::InvocationOpened {
                        configuration: Some(configuration),
                        ..
                    } = &events.events[0].event.fact
                    else {
                        panic!("missing admitted configuration")
                    };
                    assert_eq!(
                        configuration.sandbox_mode,
                        maka_runtime::execution::SandboxMode::ReadOnly
                    );
                    assert_ne!(std::path::Path::new(&configuration.cwd), fixture.workspace);
                    std::fs::write(
                        std::path::Path::new(&configuration.cwd).join("result.txt"),
                        "exported child result\n",
                    )
                    .unwrap();
                    assert_eq!(
                        configuration
                            .tool_composition
                            .as_ref()
                            .unwrap()
                            .bound_tools
                            .as_ref()
                            .unwrap(),
                        &["Read", "FinishPlugin"]
                            .into_iter()
                            .map(str::to_owned)
                            .collect()
                    );
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let patch = loop {
                match recovered
                    .workspace_patch(request.operation_id.clone())
                    .await
                {
                    Ok(Some(patch)) => break patch,
                    Err(CommandError::Busy) => tokio::time::sleep(Duration::from_millis(10)).await,
                    result => panic!("workspace export failed: {result:?}"),
                }
            };
            assert!(patch.bytes > 0);
            let chunk = recovered
                .artifact(maka_plugins::execution::ReadArtifact {
                    operation_id: request.operation_id.clone(),
                    artifact_id: patch.artifact_id.clone(),
                    offset: 0,
                    limit: 4096,
                })
                .await
                .unwrap()
                .unwrap();
            assert_eq!(chunk.total_bytes, patch.bytes);
            assert!(!chunk.bytes.is_empty());
            assert!(
                recovered
                    .artifact(maka_plugins::execution::ReadArtifact {
                        operation_id: "unknown-operation".into(),
                        artifact_id: patch.artifact_id.clone(),
                        offset: 0,
                        limit: 4096,
                    })
                    .await
                    .is_err()
            );
            assert_eq!(patch.session_id, child.session_id);
            original_patch = Some(patch);
            std::fs::write(
                fixture.workspace.join("later-parent-edit"),
                "creation replay must not replan",
            )
            .unwrap();
            replacement
                .shutdown(tokio::time::Instant::now() + Duration::from_secs(1))
                .await
                .unwrap();
            let disabled = peer.rpc("plugin.composition.apply", json!({"operations":[{"type":"update","entryId":"example","patch":{"disabled":true}}]})).await;
            assert_eq!(disabled["ok"], true, "{disabled}");
            loop {
                let tools = peer
                    .rpc("plugin.platform.query", json!({"view":"tools"}))
                    .await;
                assert_eq!(tools["ok"], true, "{tools}");
                if tools["result"]["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|tool| tool["toolName"] != "FinishPlugin")
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        }
        peer.close().await;
        stop.cancel();
        server.await.unwrap().unwrap();
        cleanup.disarm();
        drop(host);
    }
}

fn tool_call(id: &str, name: &str, input: serde_json::Value) -> serde_json::Value {
    json!({"index":0,"delta":{"tool_calls":[{"index":0,"id":id,"type":"function","function":{"name":name,"arguments":input.to_string()}}]},"finish_reason":"tool_calls"})
}

fn native_plugin() -> maka_runtime_host::plugins::Setup {
    use maka_plugins::kernel::Definition;
    use std::{collections::BTreeMap, sync::Arc};
    maka_runtime_host::plugins::Setup {
        builtins: BTreeMap::from([(
            "example".into(),
            Arc::new(Definition {
                id: "example".into(),
                revision: "binary".into(),
                dependencies: vec![],
                inject: vec![],
                plugin: Arc::new(Finish),
            }),
        )]),
        layers: BTreeMap::from([(
            "example".into(),
            vec![
                serde_json::from_value(json!({
                    "type":"insert", "entry":{"id":"example","packageId":"example"}
                }))
                .unwrap(),
            ],
        )]),
        ..Default::default()
    }
}

struct Finish;
impl maka_plugins::kernel::Plugin for Finish {
    fn activate(
        &self,
        _: maka_plugins::kernel::PluginContext,
        _: serde_json::Value,
    ) -> futures_util::future::BoxFuture<'static, Result<maka_plugins::contributions::Staged, String>>
    {
        Box::pin(async {
            use maka_tools::{
                ToolDefinition, ToolHandler, ToolNesting, ToolRegistration, ToolSemantics,
            };
            let mut staged = maka_plugins::contributions::Staged::default();
            let tool = maka_tools::plugins::PluginTool::new(ToolRegistration {
                definition: ToolDefinition { provider: None, name: "FinishPlugin".into(), description: "FinishPlugin integration capability".into(),
                    input_schema: json!({"type":"object","properties":{"value":{"type":"string"}},"required":["value"],"additionalProperties":false}) },
                nesting: ToolNesting::DirectOnly, semantics: ToolSemantics::FinishTurn,
                handler: ToolHandler::Immediate(std::sync::Arc::new(Finish)),
            }).map_err(|error| error.to_string())?;
            staged
                .insert("FinishPlugin", tool)
                .map_err(|error| error.to_string())?;
            staged
                .insert(
                    "prepare-public-input",
                    maka_plugins::input::InputPreparation(std::sync::Arc::new(Finish)),
                )
                .map_err(|error| error.to_string())?;
            Ok(staged)
        })
    }
}
impl maka_runtime::tools::ToolExecutor for Finish {
    fn names(&self) -> Vec<String> {
        vec!["FinishPlugin".into()]
    }
    fn invoke(
        &self,
        _: String,
        input: serde_json::Value,
        _: CancellationToken,
    ) -> maka_runtime::tools::ToolFuture {
        Box::pin(async move { Ok(input) })
    }
}

impl maka_plugins::input::Provider for Finish {
    fn prepare(
        &self,
        mut request: maka_plugins::input::Request,
        _: maka_plugins::filesystem::ReadDirectory,
    ) -> futures_util::future::BoxFuture<
        'static,
        Result<maka_plugins::input::Outcome, maka_plugins::Error>,
    > {
        Box::pin(async move {
            use maka_plugins::input::Outcome;
            match request.content.text.as_str() {
                "block" => Ok(Outcome::Blocked {
                    message: "Input explicitly blocked".into(),
                    receipt: json!(null),
                }),
                "work" => {
                    request.content.text.push_str("\nPUBLIC_INPUT_PREPARED");
                    Ok(Outcome::Ready {
                        content: request.content,
                        receipt: json!({"prepared":true}),
                        required_tools: Default::default(),
                        basis: None,
                    })
                }
                _ => Ok(Outcome::Unchanged),
            }
        })
    }
}

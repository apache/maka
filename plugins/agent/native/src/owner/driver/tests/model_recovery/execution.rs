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
use maka_agent_state::queue::{Placement, PreparedRequest, QueueCommand, QueueEdit, RequestId};
use maka_event_log::checkpoints::{
    Scope as CheckpointScope,
    execution::{Claim, ClaimResult, Execution, ExecutionAuthority, Permissions, Status},
    repository::{SessionRepository, Source, files::FileRepository},
};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn execution_grant_gates_real_host_and_drains_before_handoff() {
    let mut rig = Rig::new().unwrap();
    let result = AssertUnwindSafe(tokio::time::timeout(
        Duration::from_secs(120),
        exercise(&mut rig, false, false),
    ))
    .catch_unwind()
    .await;
    let cleanup = rig.finish().await;
    assert!(matches!(result, Ok(Ok(Ok(())))), "{result:?}");
    assert!(cleanup.is_empty(), "{cleanup:?}");
}

async fn exercise(rig: &mut Rig, expire: bool, recovery: bool) -> TestResult<()> {
    let base = rig.directory.path().to_path_buf();
    let mut provider = MockAiBuilder::new().interactive(1).start().await?;
    let mut observed = provider.take_interactive_rx().unwrap();
    let boot = bootstrap_deployment(&base, provider.base_url(), true, |config| {
        config["todo"] = json!(true);
        config["goals"] = json!(true);
        config["scheduledTasks"] = json!(true);
        config["permissions"]["access"] = json!("danger_full_access");
        config["permissions"]["requestPermissions"] = json!(true);
        config["tools"] = json!([
            {"name":"Write","description":"Write a file","target":{"kind":"import","name":"files"},"method":"write","nestable":true,"result":"json","confirmation":"preapproved"},
            {"name":"Shell","description":"Run a command","target":{"kind":"import","name":"processes"},"method":"execute","input":"shell","nestable":true,"result":"json","confirmation":"preapproved"},
            {"name":"WebFetch","description":"Fetch a page","target":{"kind":"import","name":"web"},"method":"fetch","input":"web","nestable":true,"result":"json","confirmation":"preapproved"}
        ]);
    }).await?;
    attach(rig, &boot).await?;
    let client = rig.client.as_ref().unwrap();
    let catalog = call(client, "settings", "connections", json!({"kind":"start"})).await?;
    let connection = call(client, "settings", "create", json!({
        "expectedCatalogRevision":catalog["revision"],
        "connection":{"slug":"execution","name":"Execution fixture",
            "provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"ollama"},
            "configuration":{"baseUrl":boot.base_url},"enabled":true,"enabledModelIds":["llama3.2"],
            "modelOverrides":{"llama3.2":{"codeMode":false,"apiProtocol":"openai-chat-completions"}}}
    })).await?;
    assert_eq!(connection["kind"], "committed");
    let backend = json!({"kind":"model","connectionId":connection["connection"]["connectionId"],"modelId":"llama3.2"});
    let mut sessions = Vec::new();
    for title in ["Authorized", "Outside grant"] {
        let created = call(
            client,
            "agent",
            "create",
            json!({
                "title":title,"automaticTitle":false,"labels":[],
                "workspace":{"kind":"directory","path":base.join("workspace")}
            }),
        )
        .await?;
        sessions.push(
            created["session"]["id"]
                .as_str()
                .ok_or("Session missing")?
                .to_owned(),
        );
    }
    let mut retained = Vec::new();
    let mut queued = Vec::new();
    if recovery {
        let owner = rig.captured.lock().unwrap().clone().unwrap();
        let mut originals = Vec::new();
        for session in &sessions {
            let sent = call(client, "agent", "send", json!({"sessionId":session,"message":"Capture the original permissions.","backend":backend})).await?;
            observed
                .recv()
                .await
                .ok_or("initial model request missing")?
                .reply_text("Captured.");
            quiescent_message(client, session, &sent["messageId"]).await?;
            let run = owner
                .durable
                .latest_run(session.clone())
                .await?
                .ok_or("original Run missing")?;
            originals.push(owner.durable.frontier(run).await?);
        }
        // Stop scheduling, then persist unfinished admissions through the storage contract.
        // Their permissions come from real unrestricted sends, not a mutated in-memory Run.
        owner.stop.cancel();
        owner.producers.close();
        owner.producers.wait().await;
        for original in originals {
            let mut contents = Vec::new();
            for reference in original.spec.content_refs() {
                contents.push(ContentBlob::new(
                    owner
                        .durable
                        .content(original.run, reference.clone())
                        .await?,
                ));
            }
            let input: RunInput = serde_json::from_slice(
                &owner
                    .durable
                    .content(original.run, original.spec.input.clone())
                    .await?,
            )?;
            let RunInput::Message {
                mut source_messages,
                ..
            } = input
            else {
                return Err("message input missing".into());
            };
            let mut source = source_messages.pop().ok_or("message source missing")?;
            source.message.message_id = Uuid::new_v4().to_string();
            let queue_input = ContentBlob::json(&RunInput::Message {
                content: source.message.content.clone(),
                request_fingerprint: None,
                source_messages: vec![source.clone()],
            })?;
            let source_blob = ContentBlob::json(&source)?;
            let resources = ContentBlob::json(
                &json!({"kind":"message_resources","attachments":null,"reacquisition":{"kind":"immutable_user_uploads","requiresAuthorization":true}}),
            )?;
            let mut queue_spec = original.spec.clone();
            queue_spec.turn_id = Uuid::new_v4().to_string();
            queue_spec.trigger = Trigger::Message {
                message_id: source.message.message_id.clone(),
            };
            queue_spec.input = queue_input.reference().clone();
            let session = queue_spec.session_id.clone();
            let queued_request = PreparedRequest {
                id: RequestId(Uuid::new_v4().to_string()),
                message_id: source.message.message_id.clone(),
                spec: queue_spec,
                source: source_blob.reference().clone(),
                resources: resources.reference().clone(),
                required_tools: Default::default(),
            };
            let queue = owner.durable.queue();
            queue
                .execute(
                    session.clone(),
                    QueueCommand {
                        id: FactId::new(),
                        at: at(),
                        expected_revision: queue.read(session.clone()).await?.revision,
                        edit: QueueEdit::Enqueue {
                            request: Box::new(queued_request),
                            placement: Placement::Followup,
                        },
                    },
                    vec![queue_input, source_blob, resources],
                )
                .await?;
            queued.push((session.clone(), queue.read(session).await?));
            let mut spec = original.spec;
            spec.turn_id = Uuid::new_v4().to_string();
            source.message.message_id = Uuid::new_v4().to_string();
            spec.trigger = Trigger::Message {
                message_id: source.message.message_id.clone(),
            };
            let input = ContentBlob::json(&RunInput::Message {
                content: source.message.content.clone(),
                request_fingerprint: None,
                source_messages: vec![source],
            })?;
            spec.input = input.reference().clone();
            contents.push(input);
            let admission = Admission::new(spec, at(), contents);
            let run = admission.run();
            owner.durable.admit(admission).await?;
            retained.push((run, facts(&owner.durable, run).await?));
        }
    }
    let source = {
        let owner = rig.captured.lock().unwrap().clone().unwrap();
        Source {
            root_id: owner.store.owned_root()?.root_id().into(),
            scope: CheckpointScope {
                state_domain: owner.data_source.state_domain.clone(),
                deployment: owner.data_source.deployment,
                namespace: owner.data_source.namespace.clone(),
            },
            session: sessions[0].clone(),
        }
    };
    assert!(rig.finish().await.is_empty());
    rig.client = None;
    rig.host = None;
    rig.store = None;
    rig.captured.lock().unwrap().take();
    rig.stop_serving = CancellationToken::new();

    let directory = tempfile::tempdir()?;
    let repository = Arc::new(FileRepository::open(directory.path())?);
    let binding = repository.bind(source, Uuid::new_v4()).await?;
    let request = Claim {
        activation: Uuid::new_v4(),
        binding: binding.clone(),
        start: None,
        permissions: Permissions {
            sandbox: maka_sandbox::Sandbox::Managed {
                filesystem: maka_sandbox::filesystem::Policy::uniform(
                    maka_sandbox::filesystem::Access::Read,
                ),
                network: maka_sandbox::Network::Denied,
            },
            tools: Some(vec![
                "todo_read".into(),
                "Write".into(),
                "Shell".into(),
                "WebFetch".into(),
                "CreateGoal".into(),
                "ScheduledTask".into(),
            ]),
        },
        lease_millis: if expire { 2_000 } else { 120_000 },
    };
    let ClaimResult::Granted { grant, .. } = repository.claim(request.clone()).await? else {
        return Err("grant missing".into());
    };
    let grant = Arc::new(*grant);
    let execution = Execution::attach(repository.clone(), grant.clone()).await?;
    let storage = repository
        .storage(binding.identity.agent)?
        .with_execution(execution.clone())?;
    let root_base = base.clone();
    let root = tokio::task::spawn_blocking(move || {
        RootOwner::open(
            &root_base.join("root"),
            &RootNamespaces {
                ownership: root_base.join("owners"),
                control: root_base.join("control"),
            },
        )
    })
    .await??;
    let mut migrations = maka_event_log::ROOT_MIGRATIONS.to_vec();
    migrations.extend_from_slice(maka_agent_state::MIGRATIONS);
    migrations.sort_by_key(|m| m.version);
    let store = Arc::new(
        RootStore::open_with_checkpoint_storage(Arc::new(root), &migrations, Some(storage)).await?,
    );
    rig.attach_host(store, boot.deployment, boot.gateway, true, None)
        .await?;
    let client = rig.client.as_ref().unwrap();
    if recovery {
        let owner = rig.captured.lock().unwrap().clone().unwrap();
        // Let the real activated scheduler reconcile multiple times while mutations wake it.
        for _ in 0..3 {
            owner.wake_notify.notify_one();
            assert!(
                tokio::time::timeout(Duration::from_millis(200), observed.recv())
                    .await
                    .is_err(),
                "restart executed a foreign or overprivileged Run"
            );
            for (run, original) in &retained {
                assert_eq!(
                    &facts(&owner.durable, *run).await?,
                    original,
                    "recovery wrote failure/blocker facts without authority"
                );
            }
            for (session, original) in &queued {
                assert_eq!(
                    &owner.durable.queue().read(session.clone()).await?,
                    original,
                    "recovery consumed unauthorized queued work"
                );
            }
        }
        rig.host.as_ref().unwrap().stop_execution().await?;
        provider.shutdown().await;
        return Ok(());
    }
    let next = if expire {
        Claim {
            activation: Uuid::new_v4(),
            start: None,
            ..request
        }
    } else {
        assert!(
            call(
                client,
                "agent",
                "send",
                json!({
                    "sessionId":sessions[1],"message":"Not authorized.","backend":backend
                })
            )
            .await
            .is_err()
        );
        let sent = call(
            client,
            "agent",
            "send",
            json!({
                "sessionId":sessions[0],"message":"Read the todo list.","backend":backend
            }),
        )
        .await?;
        assert_eq!(sent["kind"], "queued", "{sent}");
        let reply = observed.recv().await.ok_or("model request missing")?;
        for forbidden in ["todo_write", "CreateGoal", "GoalStatus", "ScheduledTask"] {
            assert!(
                !super::bot_tools::has_tool(reply.body(), forbidden),
                "{forbidden}"
            );
        }
        for name in ["Write", "Shell", "WebFetch"] {
            assert!(super::bot_tools::has_tool(reply.body(), name), "{name}");
        }
        reply.send_plan(super::bot_tools::tool_response("todo_read", json!({})));
        let mut reply = observed.recv().await.ok_or("tool result missing")?;
        assert!(
            reply.body()["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["role"] == "tool")
        );
        let blocked_file = base.join("workspace/forbidden.txt");
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let url = format!("http://{}/forbidden", listener.local_addr()?);
        for (name, input) in [
            (
                "Write",
                json!({"path":"forbidden.txt","content":"must not write"}),
            ),
            ("WebFetch", json!({"url":url})),
            (
                "Shell",
                json!({"command":"echo unauthorized > forbidden.txt","login":false,
            "additional_permissions":{"filesystem":[{"path":blocked_file,"scope":"exact","access":"write"}],"network":"allowed"},
            "justification":"Request broader access"}),
            ),
        ] {
            reply.send_plan(super::bot_tools::tool_response(name, input));
            reply = observed.recv().await.ok_or("denied tool result missing")?;
            let tool = reply.body()["messages"]
                .as_array()
                .unwrap()
                .iter()
                .rev()
                .find(|m| m["role"] == "tool")
                .ok_or("tool receipt missing")?;
            let content = tool["content"].as_str().ok_or("tool result not text")?;
            assert!(
                content.contains("failed")
                    || content.contains("denied")
                    || content.contains("permission")
                    || content.contains("Permission"),
                "{name}: {content}"
            );
            assert!(!blocked_file.exists(), "grant allowed a forbidden write");
            let pending = call(
                client,
                "agent",
                "pendingInteractions",
                json!({"sessionId":sessions[0]}),
            )
            .await?;
            assert!(
                pending["entries"].as_array().unwrap().is_empty(),
                "grant ceiling became an approvable request: {pending}"
            );
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err(),
            "denied network tool reached its destination"
        );
        reply.reply_text("Done.");
        quiescent_message(client, &sessions[0], &sent["messageId"]).await?;
        // Exercise the real mutation dispatcher, including methods unrelated to send.
        let current = call(client, "agent", "observe", json!({"sessionId":sessions[0]})).await?;
        let renamed = call(
            client,
            "agent",
            "metadata",
            json!({
                "sessionId":sessions[0], "expectedRevision":current["session"]["revision"],
                "title":"Authorized rename", "labels":[]
            }),
        )
        .await?;
        assert_eq!(renamed["kind"], "committed");
        let foreign = call(client, "agent", "observe", json!({"sessionId":sessions[1]})).await?;
        for (method, input) in [
            (
                "metadata",
                json!({"sessionId":sessions[1],"expectedRevision":foreign["session"]["revision"],"title":"Unauthorized rename","labels":[]}),
            ),
            (
                "changeSession",
                json!({"sessionId":sessions[1],"expectedRevision":1,"action":"remove"}),
            ),
            (
                "saveFile",
                json!({"sessionId":sessions[1],"path":maka_fs_tools::path::WorkspacePath::from_bytes(b"forbidden.txt")?,"expectedVersion":"missing"}),
            ),
            (
                "create",
                json!({"title":"Unauthorized","automaticTitle":false,"labels":[],"workspace":{"kind":"directory","path":base.join("workspace")}}),
            ),
            (
                "fork",
                json!({"sessionId":sessions[0],"expectedRevision":1,"position":{"kind":"end"},"title":"Unauthorized fork","labels":[]}),
            ),
        ] {
            let mut attachments = Attachments::new();
            if method == "saveFile" {
                attachments.insert("content".into(), Arc::new(EditedText));
            }
            let error = call_with_attachments(client, "agent", method, input, attachments)
                .await
                .unwrap_err()
                .to_string();
            assert!(
                error.contains("execution grant") || error.contains("execution_grant"),
                "{method}: {error}"
            );
        }
        assert_eq!(
            call(client, "agent", "observe", json!({"sessionId":sessions[1]})).await?,
            foreign
        );
        // The real publisher uses the same generation-aware repository adapter.
        let preview = call(
            client,
            "agent",
            "previewHistoryCheckpoint",
            json!({"sessionId":sessions[0]}),
        )
        .await?;
        let published = call(
            client,
            "agent",
            "publishCheckpoint",
            json!({
                "sessionId":sessions[0],"expectedRevision":null,
                "confirmedSubtreeDigest":preview["subtreeDigest"],"workspaceConsistency":null
            }),
        )
        .await?;
        assert_eq!(published["state"]["kind"], "published", "{published}");
        let head = repository
            .read_head(binding.identity.clone())
            .await?
            .ok_or("Head missing")?;
        Claim {
            activation: Uuid::new_v4(),
            start: Some(head.head.revision),
            ..request
        }
    };

    call(
        client,
        "agent",
        "send",
        json!({
            "sessionId":sessions[0],"message":"Keep the model request pending.","backend":backend
        }),
    )
    .await?;
    let held_response = observed.recv().await.ok_or("held request missing")?;
    let held_response = if expire {
        Some(held_response)
    } else {
        assert_eq!(repository.revoke(grant.clone()).await?, Status::Draining);
        // A non-Service tool proposed right after revoke must be fenced at validate_tool
        // without waiting for the background watcher tick.
        held_response.send_plan(super::bot_tools::tool_response("todo_read", json!({})));
        None
    };
    assert_eq!(repository.claim(next.clone()).await?, ClaimResult::Busy);
    let host = rig.host.as_ref().unwrap();
    tokio::time::timeout(Duration::from_secs(30), async {
        while !host.status().closed {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await?;
    assert!(host.status().cleanup_error.is_none(), "{:?}", host.status());
    // The watch must stop the Host itself; only then may the supervisor acknowledge it.
    assert_eq!(repository.observe(grant.clone()).await?, Status::Draining);
    assert!(call(client, "agent", "send", json!({
        "sessionId":sessions[0],"message":"Old writer must not start again.","backend":backend
    })).await.is_err());
    assert!(
        call(
            client,
            "agent",
            "metadata",
            json!({
                "sessionId":sessions[0],"expectedRevision":1,"title":"Revoked","labels":[]
            })
        )
        .await
        .is_err()
    );
    assert!(!base.join("workspace/forbidden.txt").exists());
    if let Some(held_response) = held_response {
        tokio::time::timeout(Duration::from_secs(5), held_response.wait_closed()).await?;
        drop(held_response);
    }
    rig.host.as_ref().unwrap().stop_execution().await?;
    assert_eq!(repository.observe(grant.clone()).await?, Status::Stopped);
    assert_eq!(
        repository.claim(next.clone()).await?,
        ClaimResult::Busy,
        "rejected activation retains original reply"
    );
    let successor = repository
        .claim(Claim {
            activation: Uuid::new_v4(),
            ..next
        })
        .await?;
    assert!(
        matches!(successor, ClaimResult::Granted { grant: g, .. } if g.generation == grant.generation + 1)
    );
    assert!(
        observed.try_recv().is_err(),
        "revoked Host issued another model request"
    );
    provider.shutdown().await;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lease_expiry_automatically_drains_real_host() {
    let mut rig = Rig::new().unwrap();
    let result = AssertUnwindSafe(tokio::time::timeout(
        Duration::from_secs(120),
        exercise(&mut rig, true, false),
    ))
    .catch_unwind()
    .await;
    let cleanup = rig.finish().await;
    assert!(matches!(result, Ok(Ok(Ok(())))), "{result:?}");
    assert!(cleanup.is_empty(), "{cleanup:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn managed_restart_preserves_foreign_and_overprivileged_unfinished_work() {
    let mut rig = Rig::new().unwrap();
    let result = AssertUnwindSafe(tokio::time::timeout(
        Duration::from_secs(120),
        exercise(&mut rig, false, true),
    ))
    .catch_unwind()
    .await;
    let cleanup = rig.finish().await;
    assert!(matches!(result, Ok(Ok(Ok(())))), "{result:?}");
    assert!(cleanup.is_empty(), "{cleanup:?}");
}

struct EditedText;
impl maka_capabilities::call::ReadResource for EditedText {
    fn encoding(&self) -> maka_capabilities::call::ResourceEncoding {
        maka_capabilities::call::ResourceEncoding::Utf8
    }
    fn resource_type(&self) -> maka_plugin_core::contract::ResourceType {
        maka_plugin_core::contract::text_resource_type()
    }
    fn bytes(&self) -> usize {
        b"forbidden edit".len()
    }
    fn metadata(&self) -> Value {
        json!({})
    }
    fn read(&self, range: std::ops::Range<usize>) -> Result<Vec<u8>, String> {
        b"forbidden edit"
            .get(range)
            .map(<[u8]>::to_vec)
            .ok_or_else(|| "invalid range".into())
    }
}

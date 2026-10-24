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
#[path = "acp/setup_tests.rs"]
mod setup_tests;
#[path = "acp/post_cleanup.rs"]
mod post_cleanup;

async fn setup(
    protocol: u8,
) -> (
    Fixture,
    TcpListener,
    std::path::PathBuf,
    maka_agent_api::acp::Configuration,
) {
    let fixture = Fixture::new("http://127.0.0.1:9/v1", None).await;
    let control = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let node = tokio::process::Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
        .await
        .unwrap();
    assert!(node.status.success());
    let trace = fixture.workspace.join("acp-requests.jsonl");
    let configuration = maka_agent_api::acp::Configuration {
        agent: maka_external_agent::Agent {
            id: "test.acp".into(),
            display_name: "Test ACP".into(),
            executable: String::from_utf8(node.stdout).unwrap().trim().into(),
            args: vec![
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../platform/host-runtime/tests/support/acp-agent.mjs")
                    .to_str()
                    .unwrap()
                    .into(),
                trace.to_str().unwrap().into(),
                control.local_addr().unwrap().port().to_string(),
                protocol.to_string(),
            ],
            env: BTreeMap::new(),
        },
        permissions: Some(maka_sandbox::grant::Permissions {
            filesystem: vec![],
            network: maka_sandbox::Network::Allowed,
        }),
    };
    (fixture, control, trace, configuration)
}
#[tokio::test]
async fn native_acp_reuses_process_and_restores_original_conversation() {
    reuse(1).await;
}
#[tokio::test]
async fn native_acp_v2_reuses_process_and_resumes_original_conversation() {
    reuse(2).await;
}
#[tokio::test]
async fn native_acp_continues_after_only_its_caller_is_reactivated() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let (mut f, control, trace, configuration) = setup(2).await;
        activate_backend(&mut f, true, None, true, Some(configuration), &[]).await;
        let session = f.create("ACP caller replacement").await;
        let first = execute(&f, &session, "before replacement").await;
        let permission = super::super::files::pending(&f, &session).await;
        super::super::files::answer(&f, &permission, Some("session")).await;
        let (_process, _) = control.accept().await.unwrap();
        f.drained().await;
        assert_eq!(
            work(&f, &session, &first).await["execution"]["state"],
            "completed"
        );
        let client = f.app.client();
        let caller = client.activation(&id(1)).unwrap();
        let backend = client.activation(&id(21)).unwrap();
        let processes = client.activation(&id(22)).unwrap();
        let loaded = f
            .store
            .load_application(f.app.source().unwrap().deployment)
            .await
            .unwrap()
            .unwrap();
        let (loaded_source, loaded_packages, _, _) = loaded.into_parts();
        let mut input = loaded_source.input;
        input
            .instances
            .get_mut("provider")
            .unwrap()
            .configuration
            .values
            .insert("toolDiscovery".into(), json!(true));
        let source = f
            .store
            .commit_application(
                loaded_source.reference.deployment,
                loaded_source.reference.revision,
                input,
                vec![],
                loaded_packages,
            )
            .await
            .unwrap();
        f.app.adopt_committed(source).await.unwrap();
        f.app.ready().await.unwrap();
        assert_ne!(client.activation(&id(1)).unwrap(), caller);
        assert_eq!(client.activation(&id(21)).unwrap(), backend);
        assert_eq!(client.activation(&id(22)).unwrap(), processes);
        let mut changes = f.session(&session).await.subscribe_commits().unwrap();
        let next = execute(&f, &session, "after replacement").await;
        loop {
            let observed = work(&f, &session, &next).await;
            match observed["execution"]["state"].as_str() {
                Some("running") | Some("admitted") | Some("waiting_for_user") | None => {
                    changes.changed().await.unwrap();
                }
                _ => {
                    assert_eq!(observed["execution"]["state"], "completed", "{observed}");
                    break;
                }
            }
        }
        let requests = std::fs::read_to_string(trace).unwrap();
        let requests: Vec<Value> = requests
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(
            requests.iter().filter(|v| v["method"] == "spawn").count(),
            1
        );
        assert_eq!(
            requests
                .iter()
                .filter(|v| v["method"] == "session/new")
                .count(),
            1
        );
        assert_eq!(
            requests
                .iter()
                .filter(|v| v["method"] == "session/prompt")
                .count(),
            2
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
async fn reuse(protocol: u8) {
    tokio::time::timeout(Duration::from_secs(90), async {
        let (mut fixture, control, trace, configuration) = setup(protocol).await;
        activate_backend(&mut fixture, true, None, true, Some(configuration.clone()), &[]).await;
        let session = fixture.create("ACP native").await;
        let accepted = fixture.mutation(2,"execute",json!({"sessionId":session,"message":"first", "executor":{"executor":"external","settings":{}}}),Uuid::new_v4()).await.unwrap();
        assert_eq!(accepted["kind"],"started");
        // Network is consented through the original Session interaction, never
        // granted merely by installing the ACP configuration.
        let permission = super::super::files::pending(&fixture, &session).await;
        if protocol == 1 { reject_changed_authority(&fixture, &session).await; }
        super::super::files::answer(&fixture, &permission, Some("session")).await;
        let _probe = if protocol != 2 { Some(control.accept().await.unwrap().0) } else { None };
        let (stream, _) = control.accept().await.unwrap();
        let mut stream = tokio::io::BufReader::new(stream);
        let mut pid = String::new();
        tokio::io::AsyncBufReadExt::read_line(&mut stream, &mut pid).await.unwrap();
        fixture.drained().await;
        let observed = work(&fixture,&session,&accepted).await;
        assert_eq!(observed["execution"]["state"],"completed","{observed}");
        let second = fixture.mutation(2,"execute",json!({"sessionId":session,"message":"second", "executor":{"executor":"external","settings":{}}}),Uuid::new_v4()).await.unwrap();
        fixture.drained().await;
        let observed = work(&fixture,&session,&second).await;
        assert_eq!(observed["execution"]["state"],"completed","{observed}");
        let requests = std::fs::read_to_string(&trace).unwrap();
        let requests:Vec<Value> = requests.lines().map(|line|serde_json::from_str(line).unwrap()).collect();
        assert_eq!(requests.iter().filter(|v|v["method"]=="spawn").count(),if protocol==2 {1}else{2});
        assert_eq!(requests.iter().filter(|v|v["method"]=="session/new").count(),1);
        assert_eq!(requests.iter().filter(|v|v["method"]=="session/prompt").count(),2);
        assert!(!requests.iter().any(|v|v["method"]=="session/load"));
        activate_backend(&mut fixture, false, None, true, Some(configuration), &[]).await;
        assert!(std::process::Command::new("/bin/kill").args(["-0",pid.trim()]).output().unwrap().status.code().is_some_and(|c| c!=0));
        let third = fixture.mutation(2,"execute",json!({"sessionId":session,"message":"third", "executor":{"executor":"external","settings":{}}}),Uuid::new_v4()).await.unwrap();
        let _probe = if protocol != 2 { Some(control.accept().await.unwrap().0) } else { None };
        let (_stream, _) = control.accept().await.unwrap();
        fixture.drained().await;
        let observed = work(&fixture,&session,&third).await;
        assert_eq!(observed["execution"]["state"],"completed","{observed}");
        let requests = std::fs::read_to_string(&trace).unwrap();
        let requests:Vec<Value> = requests.lines().map(|line|serde_json::from_str(line).unwrap()).collect();
        assert_eq!(requests.iter().filter(|v|v["method"]=="session/new").count(),1);
        assert_eq!(requests.iter().filter(|v|v["method"]==if protocol==2 {"session/resume"}else{"session/load"}).count(),1);
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

async fn execute(f: &Fixture, session: &str, text: &str) -> Value {
    let result = f.mutation(2,"execute",json!({"sessionId":session,"message":text,"executor":{"executor":"external","settings":{}}}),Uuid::new_v4()).await.unwrap();
    assert_eq!(result["kind"], "started", "{result}");
    result
}
async fn form(f: &Fixture, session: &str) -> maka_agent_facts::interaction::InteractionRecord {
    let mut changes = f.session(&session).await.subscribe_commits().unwrap();
    loop {
        if let Some(record) = f
            .session(session)
            .await
            .pending_interactions(session)
            .await
            .unwrap()
            .into_iter()
            .find(|r| {
                matches!(
                    r.request,
                    maka_agent_facts::interaction::InteractionRequest::Form { .. }
                )
            })
        {
            return record;
        }
        tokio::time::timeout(Duration::from_secs(10), changes.changed())
            .await
            .expect("ACP form did not arrive")
            .unwrap();
    }
}
#[tokio::test]
async fn native_acp_callbacks_have_distinct_writes_and_cancel_the_original_form() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let (mut f, control, _trace, configuration) = setup(1).await;
        activate_backend(&mut f,true,None,true,Some(configuration), &[]).await;
        let session = f.create("ACP callbacks").await;
        std::fs::write(f.workspace.join("input.txt"),"fixture contents\n").unwrap();
        let mut process = None;
        let mut probe = None;
        for text in ["callbacks","callbacks","peer-cancel"] {
            let accepted = execute(&f,&session,text).await;
            let permission = super::super::files::pending(&f,&session).await;
            super::super::files::answer(&f,&permission,Some("once")).await;
            if process.is_none() {
                probe=Some(control.accept().await.unwrap().0);
                process=Some(control.accept().await.unwrap().0);
            }
            let record = form(&f,&session).await;
            if text=="peer-cancel" {
                process.as_mut().unwrap().write_all(b"cancel-permission\n").await.unwrap();
            } else {
                f.mutation(2,"respond",json!({"sessionId":session,"requestId":record.request_id,
                    "answer":{"kind":"form","action":"accept","values":{"permission":"allow-once"}}}),Uuid::new_v4()).await.unwrap();
            }
            f.drained().await;
            let observed=work(&f,&session,&accepted).await;
            assert_eq!(observed["execution"]["state"],"completed","{observed}");
            assert_eq!(observed["answer"]["text"],if text=="peer-cancel" {"permission cancelled"}else{"callbacks complete"});
            assert!(f.session(&session).await.pending_interactions(&session).await.unwrap().is_empty());
        }
        assert_eq!(std::fs::read_to_string(f.workspace.join("written.txt")).unwrap(),"written through Host\n");
        let writes=f.store.application_intents(f.app.source().unwrap().deployment,id(21),0,128).await.unwrap();
        let writes=writes.iter().filter(|r|r.reference.namespace==id(23)&&r.reference.method=="write").collect::<Vec<_>>();
        assert_eq!(writes.len(),3,"identical callbacks remain distinct accepted writes");
        for write in writes { assert!(matches!(f.store.operation(&write.reference).unwrap().operation_observation().await.unwrap().unwrap().outcome,OperationOutcome::Returned{..})); }
        drop(probe);
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}
#[tokio::test]
async fn native_acp_does_not_replay_a_prompt_after_process_loss_and_reactivation() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let (mut f, control, trace, configuration) = setup(1).await;
        activate_backend(&mut f, true, None, true, Some(configuration.clone()), &[]).await;
        let session = f.create("ACP unknown").await;
        let first = execute(&f, &session, "lose").await;
        let permission = super::super::files::pending(&f, &session).await;
        super::super::files::answer(&f, &permission, Some("session")).await;
        let (_probe, _) = control.accept().await.unwrap();
        let (_process, _) = control.accept().await.unwrap();
        f.drained().await;
        assert_eq!(
            work(&f, &session, &first).await["execution"]["state"],
            "failed"
        );
        activate_backend(&mut f, false, None, true, Some(configuration), &[]).await;
        let second = execute(&f, &session, "must not resend").await;
        f.drained().await;
        let observed = work(&f, &session, &second).await;
        assert_eq!(observed["execution"]["state"], "failed", "{observed}");
        let requests = std::fs::read_to_string(trace).unwrap();
        let requests: Vec<Value> = requests
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(
            requests
                .iter()
                .filter(|v| v["method"] == "session/prompt")
                .count(),
            1
        );
        assert_eq!(
            requests.iter().filter(|v| v["method"] == "spawn").count(),
            2
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn native_acp_file_callback_requires_its_own_write_grant() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let (mut f, control, trace, configuration) = setup(1).await;
        activate_backend(&mut f, true, None, true, Some(configuration), &["write"]).await;
        let session = f.create("ACP denied write").await;
        std::fs::write(f.workspace.join("input.txt"), "fixture contents\n").unwrap();
        let accepted = execute(&f, &session, "callbacks").await;
        let permission = super::super::files::pending(&f, &session).await;
        super::super::files::answer(&f, &permission, Some("session")).await;
        let (_probe, _) = control.accept().await.unwrap();
        let (_process, _) = control.accept().await.unwrap();
        f.drained().await;
        let observed = work(&f, &session, &accepted).await;
        assert_eq!(observed["execution"]["state"], "failed", "{observed}");
        assert!(!f.workspace.join("written.txt").exists());
        assert!(
            f.session(&session)
                .await
                .pending_interactions(&session)
                .await
                .unwrap()
                .is_empty()
        );
        let requests = std::fs::read_to_string(trace).unwrap();
        let requests: Vec<Value> = requests
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert!(
            requests
                .iter()
                .any(|v| v["id"] == "write-file" && v.get("error").is_some())
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

async fn reject_changed_authority(f: &Fixture, session: &str) {
    let invocation = f
        .session(session)
        .await
        .session_projection::<StoredSessionConfiguration>(session)
        .await
        .unwrap()
        .unwrap()
        .root_turn
        .unwrap()
        .invocation;
    let execution_scope = f.session(session).await.execution_scope(Some(
        f.owner.session(session).await.unwrap().configuration.permission_basis(),
    )).await.unwrap();
    let execution = execution_scope.store().execution_custody().unwrap();
    for field in ["invocation", "cwd"] {
        let scope = f
            .issuer
            .issue_with_execution(
                Identity::Agent {
                    invocation: invocation.clone(),
                    operation_id: None,
                },
                true,
                CancellationToken::new(),
                execution.clone(),
            )
            .unwrap();
        let mut input = json!({"invocation":invocation,"conversationKey":"untrusted shared key","message":"must not run","cwd":f.workspace,"settings":{}});
        if field == "invocation" {
            input["invocation"]["session_id"] = json!("another-session");
        } else {
            input["cwd"] = json!("/tmp");
        }
        let client = f.app.client();
        let binding = client
            .bind(client.activation(&id(1)).unwrap(), "executor".into())
            .await
            .unwrap()
            .remove(0);
        let prepared = client
            .prepare_mutation(
                binding,
                "execute".into(),
                input,
                scope.clone(),
                Uuid::new_v4(),
                Attachments::default().into(),
            )
            .await
            .unwrap();
        let intent = f
            .store
            .record_application_intent(
                prepared.reference().source.clone(),
                prepared.consumer().instance().clone(),
                prepared.reference().clone(),
                Value::Null,
            )
            .await
            .unwrap();
        let result = client
            .mutate(prepared, intent)
            .await
            .unwrap()
            .completion()
            .await;
        result.cleanup.unwrap();
        scope.finish().await.unwrap();
        match result.reply.receipt {
            Receipt::Recorded {
                outcome: OperationOutcome::Unknown { diagnostic },
                cleanup: maka_plugin_core::operation::OperationCleanup::Confirmed,
            } => assert!(
                diagnostic.contains("does not match its admitted Session"),
                "{diagnostic}"
            ),
            receipt => panic!("unexpected forged request receipt {receipt:?}"),
        }
    }
}

#[tokio::test]
async fn native_acp_stop_settles_the_actual_process_before_releasing_execution() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let (mut f, control, trace, configuration) = setup(2).await;
        activate_backend(&mut f, true, None, true, Some(configuration), &[]).await;
        let session = f.create("ACP stop").await;
        let accepted = execute(&f, &session, "wait").await;
        let permission = super::super::files::pending(&f, &session).await;
        super::super::files::answer(&f, &permission, Some("session")).await;
        let (process, _) = control.accept().await.unwrap();
        let mut process = tokio::io::BufReader::new(process);
        let mut pid = String::new();
        tokio::io::AsyncBufReadExt::read_line(&mut process, &mut pid)
            .await
            .unwrap();
        let mut waiting = String::new();
        tokio::io::AsyncBufReadExt::read_line(&mut process, &mut waiting)
            .await
            .unwrap();
        assert_eq!(waiting.trim(), "waiting");
        let stopped = f
            .mutation(
                2,
                "stop",
                json!({"sessionId":session,"invocationId":accepted["invocationId"]}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(stopped["requested"], true);
        f.drained().await;
        assert!(
            !std::process::Command::new("/bin/kill")
                .args(["-0", pid.trim()])
                .output()
                .unwrap()
                .status
                .success()
        );
        let observed = work(&f, &session, &accepted).await;
        assert_eq!(observed["execution"]["state"], "cancelled", "{observed}");
        assert_eq!(
            std::fs::read_to_string(trace)
                .unwrap()
                .lines()
                .filter(
                    |line| serde_json::from_str::<Value>(line).unwrap()["method"]
                        == "session/prompt"
                )
                .count(),
            1
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn native_acp_v1_forwards_complete_actual_attachments_once() {
    attachment_prompt(1).await;
}
#[tokio::test]
async fn native_acp_v2_forwards_complete_actual_attachments_once() {
    attachment_prompt(2).await;
}
async fn attachment_prompt(protocol: u8) {
    use base64::{Engine, engine::general_purpose::STANDARD};
    tokio::time::timeout(Duration::from_secs(90), async {
        let (mut f, control, trace, mut configuration) = setup(protocol).await;
        configuration.agent.args.push("attachments".into());
        activate_backend(&mut f, true, None, true, Some(configuration), &[]).await;
        let session = f.create("ACP attachments").await;
        let image = b"\x89PNG\r\n\x1a\nactual binary pixels";
        let pdf = b"%PDF-1.7\n\0actual binary document";
        let text = "User attachment 独立字节\n";
        let extra: Vec<_> = (0..6).map(|index| (format!("extra-{index}.txt"), format!("ACP original extra {index} 中\nend-{index}"))).collect();
        let mut ids = Vec::new();
        for (name, bytes) in [("notes.md",text.as_bytes()), ("image.png",image.as_slice()), ("document.pdf",pdf.as_slice())]
            .into_iter().chain(extra.iter().map(|(name, bytes)| (name.as_str(), bytes.as_bytes()))) {
            let uploaded = super::super::attachments::upload(&f, &session, name, bytes, Uuid::new_v4()).await.unwrap();
            ids.push(uploaded["attachment"]["id"].clone());
        }
        let first = f.mutation(2,"execute",json!({"sessionId":session,"message":"","attachments":ids,"executor":{"executor":"external","settings":{}}}),Uuid::new_v4()).await.unwrap();
        assert_eq!(first["kind"],"started");
        let permission = super::super::files::pending(&f, &session).await;
        super::super::files::answer(&f, &permission, Some("session")).await;
        let _probe = if protocol != 2 { Some(control.accept().await.unwrap().0) } else { None };
        let (_stream, _) = control.accept().await.unwrap();
        f.drained().await;
        let observed = work(&f,&session,&first).await;
        assert_eq!(observed["execution"]["state"],"completed","{observed}");
        let requests = std::fs::read_to_string(&trace).unwrap();
        let requests: Vec<Value> = requests.lines().map(|line|serde_json::from_str(line).unwrap()).collect();
        let prompt = &requests.iter().find(|v| v["method"] == "session/prompt").unwrap()["params"]["prompt"];
        let blocks = prompt.as_array().unwrap();
        assert!(blocks.iter().any(|v| v["type"]=="resource" && v["resource"]["text"]==text));
        assert!(blocks.iter().any(|v| v["type"]=="image" && v["data"]==STANDARD.encode(image) && v["mimeType"]=="image/png"));
        assert!(blocks.iter().any(|v| v["type"]=="resource" && v["resource"]["blob"]==STANDARD.encode(pdf) && v["resource"]["mimeType"]=="application/pdf"));
        let media: Vec<_> = blocks.iter().filter(|block| matches!(block["type"].as_str(), Some("resource" | "image"))).collect();
        assert_eq!(media.len(),9);
        assert_eq!(media[0]["resource"]["text"],text);
        assert_eq!(media[1]["data"],STANDARD.encode(image));
        assert_eq!(media[2]["resource"]["blob"],STANDARD.encode(pdf));
        for (block, (_, expected)) in media[3..].iter().zip(&extra) {
            assert_eq!(block["type"],"resource");
            assert_eq!(block["resource"]["text"],*expected);
        }
        assert!(!prompt.to_string().contains(&f.workspace.to_string_lossy().to_string()));
        for id in &ids { assert!(!prompt.to_string().contains(id.as_str().unwrap())); }
        let mut large_image = vec![255;800_000];
        large_image[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        let large = super::super::attachments::upload(&f, &session, "large.png", &large_image, Uuid::new_v4()).await.unwrap();
        let large_execution = f.mutation(2,"execute",json!({"sessionId":session,"message":"complete large image","attachments":[large["attachment"]["id"]],"executor":{"executor":"external","settings":{}}}),Uuid::new_v4()).await.unwrap();
        f.drained().await;
        let large_observed = work(&f,&session,&large_execution).await;
        let third = execute(&f, &session, "after complete attachment").await;
        f.drained().await;
        let third_observed = work(&f,&session,&third).await;
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
        assert_eq!(large_execution["kind"],"started");
        assert_eq!(large_observed["execution"]["state"],"completed");
        assert_eq!(third_observed["execution"]["state"],"completed");
        let requests=std::fs::read_to_string(&trace).unwrap();
        let requests:Vec<Value>=requests.lines().map(|line|serde_json::from_str(line).unwrap()).collect();
        let prompts:Vec<_>=requests.iter().filter(|v|v["method"]=="session/prompt").collect();
        assert_eq!(prompts.len(),3,"each accepted execution reaches the peer exactly once");
        assert_eq!(requests.iter().filter(|v|v["method"]=="spawn").count(),if protocol==2 {1}else{2});
        assert_eq!(requests.iter().filter(|v|v["method"]=="session/new").count(),1);
        assert!(prompts.iter().all(|prompt|prompt["params"]["sessionId"]=="acp-persistent"));
        let large_prompt=prompts[1]["params"]["prompt"].as_array().unwrap();
        assert_eq!(large_prompt.iter().filter(|block|block["type"]=="text" && block["text"]=="complete large image").count(),1);
        let large_media:Vec<_>=large_prompt.iter().filter(|block|matches!(block["type"].as_str(),Some("resource"|"image"))).collect();
        assert_eq!(large_media.len(),1);
        assert_eq!(large_media[0]["type"],"image");
        assert_eq!(large_media[0]["mimeType"],"image/png");
        let encoded=large_media[0]["data"].as_str().unwrap();
        assert!(encoded==STANDARD.encode(&large_image),"peer receives the entire canonical image encoding");
        assert!(STANDARD.decode(encoded).unwrap()==large_image,"peer receives every original image byte");
        let wire_prompt=prompts[1]["params"]["prompt"].to_string();
        assert!(!wire_prompt.contains(&f.workspace.to_string_lossy().to_string()));
        assert!(!wire_prompt.contains(large["attachment"]["id"].as_str().unwrap()));
        let last_prompt=prompts[2]["params"]["prompt"].as_array().unwrap();
        assert_eq!(last_prompt.iter().filter(|block|block["type"]=="text" && block["text"]=="after complete attachment").count(),1);
    }).await.unwrap();
}

#[tokio::test]
async fn native_acp_rejects_unsupported_media_then_accepts_plain_text_attachment() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let (mut f,control,trace,configuration)=setup(2).await;
        activate_backend(&mut f,true,None,true,Some(configuration),&[]).await;
        let session=f.create("Text-only peer").await;
        let image=super::super::attachments::upload(&f,&session,"image.png",b"\x89PNG\r\n\x1a\nactual image",Uuid::new_v4()).await.unwrap();
        let accepted=f.mutation(2,"execute",json!({"sessionId":session,"message":"inspect image","attachments":[image["attachment"]["id"]],"executor":{"executor":"external","settings":{}}}),Uuid::new_v4()).await.unwrap();
        let permission=super::super::files::pending(&f,&session).await;
        super::super::files::answer(&f,&permission,Some("session")).await;
        let (_first,_)=control.accept().await.unwrap();
        f.drained().await;
        assert_eq!(work(&f,&session,&accepted).await["execution"]["state"],"failed");
        let text=super::super::attachments::upload(&f,&session,"notes.txt",b"actual text attachment",Uuid::new_v4()).await.unwrap();
        let accepted=f.mutation(2,"execute",json!({"sessionId":session,"message":"inspect text","attachments":[text["attachment"]["id"]],"executor":{"executor":"external","settings":{}}}),Uuid::new_v4()).await.unwrap();
        let (_second,_)=control.accept().await.unwrap();
        f.drained().await;
        assert_eq!(work(&f,&session,&accepted).await["execution"]["state"],"completed");
        let trace=std::fs::read_to_string(trace).unwrap();
        let prompts:Vec<Value>=trace.lines().map(|line|serde_json::from_str::<Value>(line).unwrap()).filter(|v|v["method"]=="session/prompt").collect();
        assert_eq!(prompts.len(),1,"unsupported image never reaches the peer");
        let content=prompts[0]["params"]["prompt"].as_array().unwrap();
        assert!(content.iter().all(|v|v["type"]=="text"));
        assert!(content.iter().any(|v|v["text"]=="actual text attachment"));
        f.app.shutdown().await.unwrap();f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

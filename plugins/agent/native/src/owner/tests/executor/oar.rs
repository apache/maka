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
use futures_util::FutureExt;
use tokio::io::{AsyncBufReadExt, BufReader};

async fn setup() -> (Fixture, TcpListener) {
    let control = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let node = tokio::process::Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
        .await
        .unwrap();
    assert!(node.status.success());
    let fixture = Fixture::configured("http://127.0.0.1:9/v1", None, None, None, |settings| {
        settings.oar = Some(maka_agent_api::executor::OarConfiguration {
            executable: Some(String::from_utf8(node.stdout).unwrap().trim().into()),
            args: vec![
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("tests/support/oar-worker.mjs")
                    .to_str()
                    .unwrap()
                    .into(),
                control.local_addr().unwrap().port().to_string(),
            ],
        });
    })
    .await;
    (fixture, control)
}
fn input(session: &str, message: &str) -> Value {
    json!({"sessionId":session,"message":message,"backend":{"kind":"executor","selection":{"executor":"oar","settings":{"runtime":"codex","model":"fixture-model","thinkingLevel":"vendor-deep"}}}})
}
async fn packet(control: &mut BufReader<TcpStream>, phase: &str) -> Value {
    let mut line = String::new();
    control.read_line(&mut line).await.unwrap();
    let value: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(value["phase"], phase);
    value
}
async fn release(control: &mut BufReader<TcpStream>) {
    control.get_mut().write_all(b"continue\n").await.unwrap();
}
async fn record(f: &Fixture) -> Value {
    use maka_capabilities::storage::{Namespace, Scan};
    let page = f
        .store
        .plugin_data_scan(
            &Namespace::new("maka.agent.oar", maka_plugin_core::scope::Scope::Profile).unwrap(),
            Scan {
                prefix: String::new(),
                after: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(page.entries.len(), 1);
    page.entries[0].record.data.value().unwrap().clone()
}
async fn check_output(f: &Fixture, session: &str) {
    let prefix = f.prefix(session, 128, 1024 * 1024).await;
    assert!(prefix.events.iter().any(|row| matches!(&row.event.fact,
        maka_agent_facts::event::Fact::ExecutorObserved { output: maka_agent_facts::executor::Output::OutputDelta { text } } if text == "committed output")));
}

#[tokio::test]
async fn native_oar_commits_identity_and_output_before_ack_and_resumes_without_replay() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = setup().await;
        let session = f.create("OAR durable ACK").await;
        for index in 0..2 {
            let operation = Uuid::new_v4();
            let input = input(&session, "complete");
            let accepted = f
                .mutation(2, "send", input.clone(), operation)
                .await
                .unwrap();
            assert_eq!(accepted["kind"], "started", "{accepted}");
            let mut control = BufReader::new(listener.accept().await.unwrap().0);
            let opened = packet(&mut control, "opened").await;
            let journal = record(&f).await;
            assert_eq!(journal["nativeSession"], "native-fixture-session");
            assert_eq!(journal["running"], accepted["invocationId"]);
            assert_eq!(opened["request"]["effort"], "vendor-deep");
            if index == 0 {
                assert!(opened["request"].get("resume").is_none());
            } else {
                assert_eq!(opened["request"]["resume"], "native-fixture-session");
            }
            release(&mut control).await;
            packet(&mut control, "output").await;
            check_output(&f, &session).await;
            let active = work(&f, &session, &accepted).await;
            assert!(
                matches!(
                    active["execution"]["state"].as_str(),
                    Some("admitted" | "running")
                ),
                "{active}"
            );
            release(&mut control).await;
            packet(&mut control, "terminal").await;
            assert_eq!(record(&f).await["running"], accepted["invocationId"]);
            release(&mut control).await;
            f.drained().await;
            let final_work = work(&f, &session, &accepted).await;
            assert_eq!(
                final_work["execution"]["state"], "completed",
                "{final_work}"
            );
            assert_eq!(final_work["answer"]["text"], "committed output");
            assert!(record(&f).await["running"].is_null());
            assert_eq!(
                f.mutation(2, "send", input, operation).await.unwrap(),
                accepted
            );
            assert!(listener.accept().now_or_never().is_none());
        }
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn native_oar_stop_waits_for_disposal_and_worker_exit() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = setup().await;
        let session = f.create("OAR stop").await;
        let accepted = f
            .mutation(2, "send", input(&session, "wait"), Uuid::new_v4())
            .await
            .unwrap();
        assert_eq!(accepted["kind"], "started", "{accepted}");
        let mut control = BufReader::new(listener.accept().await.unwrap().0);
        packet(&mut control, "opened").await;
        release(&mut control).await;
        packet(&mut control, "output").await;
        let queued = f.mutation(2,"send", input(&session,"follow-up"),Uuid::new_v4()).await.unwrap();
        assert_eq!(queued["kind"],"queued","{queued}");
        let queue = f.query("queue",json!({"sessionId":session})).await.unwrap();
        let removed = f.mutation(2,"editQueue",json!({"sessionId":session,"expectedRevision":queue["revision"],"edit":{"kind":"retract","messageId":queued["messageId"]}}),Uuid::new_v4()).await.unwrap();
        assert_eq!(removed["kind"],"committed","{removed}");
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
        packet(&mut control, "terminal").await;
        assert_eq!(record(&f).await["running"], accepted["invocationId"]);
        release(&mut control).await;
        f.drained().await;
        assert!(record(&f).await["running"].is_null());
        let observed = work(&f, &session, &accepted).await;
        assert_eq!(observed["execution"]["state"], "cancelled", "{observed}");
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn native_oar_model_list_keeps_source_identity_vendor_effort_and_snapshot_revision() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, _) = setup().await;
        let mut create = f.create_input("Invalid OAR preference").await;
        create["backend"] = json!({"kind":"executor","selection":{"executor":"oar","settings":{}}});
        let rejected = f
            .mutation(2, "create", create, Uuid::new_v4())
            .await
            .unwrap();
        assert_eq!(rejected["kind"], "rejected", "{rejected}");
        assert_eq!(rejected["reason"], "tools_unavailable");
        let page = f
            .query("models", json!({"kind":"start","query":"OAR codex"}))
            .await
            .unwrap();
        assert_eq!(page["kind"], "ready", "{page}");
        assert_eq!(page["choices"].as_array().unwrap().len(), 16);
        assert_eq!(page["choices"][0]["selection"]["kind"], "executor");
        assert_eq!(
            page["choices"][0]["selection"]["selection"]["settings"]["runtime"],
            "codex"
        );
        assert_eq!(page["choices"][0]["thinkingLevels"], json!(["vendor-deep"]));
        assert_eq!(page["choices"][0]["defaultThinkingLevel"], "vendor-deep");
        let next = f
            .query(
                "models",
                json!({"kind":"continue","revision":page["revision"],"cursor":page["next"]}),
            )
            .await
            .unwrap();
        assert_eq!(next["choices"].as_array().unwrap().len(), 4);
        assert_eq!(next["complete"], true);
        let stale = f
            .query(
                "models",
                json!({"kind":"continue","revision":"old","cursor":page["next"]}),
            )
            .await
            .unwrap();
        assert_eq!(stale["kind"], "changed");
        let mut selected = page["choices"][0]["selection"].clone();
        selected["selection"]["settings"]["thinkingLevel"] = json!("vendor-deep");
        let detail = f.query("model", json!({"backend":selected})).await.unwrap();
        assert_eq!(detail["kind"], "ready", "{detail}");
        let native = f
            .query("models", json!({"kind":"start","query":"fixture-model"}))
            .await
            .unwrap();
        assert!(
            native["choices"]
                .as_array()
                .unwrap()
                .iter()
                .any(|choice| choice["selection"]["kind"] == "model")
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn native_oar_worker_exit_without_disposal_retains_identity_and_never_replays_original_prompt()
 {
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = setup().await;
        let session = f.create("OAR unknown disposal").await;
        let operation = Uuid::new_v4();
        let input = input(&session,"crash");
        let accepted = f.mutation(2,"send",input.clone(),operation).await.unwrap();
        assert_eq!(accepted["kind"],"started","{accepted}");
        let mut control = BufReader::new(listener.accept().await.unwrap().0);
        packet(&mut control,"opened").await;
        release(&mut control).await;
        packet(&mut control,"output").await;
        release(&mut control).await;
        f.drained().await;
        assert_eq!(record(&f).await["running"],accepted["invocationId"]);
        let observed = work(&f,&session,&accepted).await;
        assert_eq!(observed["execution"]["state"],"failed","{observed}");
        let prefix = f.prefix(&session,128,1024*1024).await;
        assert!(prefix.events.iter().any(|row|matches!(&row.event.fact,maka_agent_facts::event::Fact::InvocationEnded {outcome:maka_agent_facts::event::InvocationOutcome::Failed {class,..},..} if class=="outcome_unknown")));
        assert_eq!(f.mutation(2,"send",input,operation).await.unwrap(),accepted);
        assert!(listener.accept().now_or_never().is_none());
        assert!(f.app.shutdown_if_idle().await.unwrap_err().contains("cleanup_unconfirmed"), "Unconfirmed physical ownership must not retire successfully");
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn native_oar_setup_preserves_native_unsupported_and_original_installation_receipt() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = setup().await;
        let operation = Uuid::new_v4();
        let input = json!({"runtime":"antigravity","action":{"kind":"plan","line":"stable"}});
        let result = f
            .mutation(2, "oarSetup", input.clone(), operation)
            .await
            .unwrap();
        assert_eq!(result["runtime"], "antigravity");
        assert_eq!(result["result"]["kind"], "unsupported", "{result}");
        let mut trace = BufReader::new(listener.accept().await.unwrap().0);
        let sent = packet(&mut trace, "setup").await;
        assert_eq!(sent["request"]["action"], "plan");
        assert_eq!(sent["request"]["options"], json!({"line":"stable"}));
        assert_eq!(
            f.mutation(2, "oarSetup", input, operation).await.unwrap(),
            result
        );
        assert!(listener.accept().now_or_never().is_none());
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
#[ignore = "Requires an explicitly selected OAR worker and authenticated local Codex"]
async fn native_oar_live_codex_executes_high_and_resumes_the_native_conversation() {
    tokio::time::timeout(Duration::from_secs(180), async {
        let worker = std::env::var("MAKA_OAR_TEST_WORKER").expect("Set MAKA_OAR_TEST_WORKER to the actual worker under test");
        let f = Fixture::configured("http://127.0.0.1:9/v1",None,None,None,|settings| {
            settings.oar = Some(maka_agent_api::executor::OarConfiguration {executable:Some(worker),args:vec![]});
        }).await;
        let mut create = f.create_input("Live OAR execution").await;
        create["backend"] = json!({"kind":"executor","selection":{"executor":"oar","settings":{"runtime":"codex","model":"gpt-6-astra","thinkingLevel":"high"}}});
        let created = f.mutation(2,"create",create,Uuid::new_v4()).await.unwrap();
        let session = created["session"]["id"].as_str().unwrap().to_owned();
        let marker = format!("HOST-OAR-{}",Uuid::new_v4());
        let mut native_session = None;
        for message in [format!("Remember this verification marker for our next turn: {marker}. Reply with exactly that marker, no other text. Do not use tools."),"What verification marker did I give in our previous turn? Reply with exactly that marker, no other text. Do not use tools.".into()] {
            let operation = Uuid::new_v4();
            let input = json!({"sessionId":session,"message":message});
            let accepted = f.mutation(2,"send",input.clone(),operation).await.unwrap();
            assert_eq!(accepted["kind"],"started","{accepted}");
            f.drained().await;
            let observed = work(&f,&session,&accepted).await;
            assert_eq!(observed["execution"]["state"],"completed","{observed}");
            assert_eq!(observed["answer"]["text"].as_str().unwrap().trim(),marker,"{observed}");
            let journal = record(&f).await;
            let current = journal["nativeSession"].as_str().unwrap();
            match &native_session { Some(previous)=>assert_eq!(previous,current),None=>native_session=Some(current.to_owned()) }
            assert!(journal["running"].is_null());
            assert_eq!(f.mutation(2,"send",input,operation).await.unwrap(),accepted);
        }
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

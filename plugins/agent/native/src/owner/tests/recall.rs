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
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::ToolOutcome;
use maka_agent_facts::import::Content;
use maka_agent_facts::import::Record;
use maka_agent_facts::import::Source;
use maka_capabilities::storage::Namespace;
use maka_event_log::sessions::PluginSession;
use maka_plugin_core::scope::Scope as StorageScope;

async fn imported(f: &Fixture, title: &str, prefix: &str, answer: &str) -> String {
    let seed = f.create(title).await;
    let configuration = f
        .session(&seed)
        .await
        .get_session::<StoredSessionConfiguration>(&seed)
        .await
        .unwrap()
        .unwrap()
        .configuration;
    let session = format!("{prefix}{}", Uuid::new_v4().simple());
    let plugin = PluginSession {
        session_id: session.clone(),
        creator: Namespace::new("recall.fixture", StorageScope::Profile).unwrap(),
        fingerprint: session.clone(),
        managed: false,
        authority_session_id: None,
    };

    f.store
        .import_session(
            &plugin,
            &Source {
                adapter: "fixture".into(),
                session_id: "original".into(),
            },
            &configuration,
            vec![
                Record {
                    source_message_id: "question".into(),
                    source_turn_id: "one".into(),
                    timestamp: Some(1000),
                    content: Content::User {
                        text: "Earlier cafe\u{301} 中😀 question".into(),
                    },
                },
                Record {
                    source_message_id: "answer".into(),
                    source_turn_id: "one".into(),
                    timestamp: Some(2000),
                    content: Content::Assistant {
                        text: answer.into(),
                        thinking: None,
                        model: None,
                    },
                },
                Record {
                    source_message_id: "next".into(),
                    source_turn_id: "two".into(),
                    timestamp: Some(3000),
                    content: Content::User {
                        text: "A later exchange".into(),
                    },
                },
            ],
            1,
        )
        .await
        .unwrap();

    session
}
#[tokio::test]
async fn recall_native_queries_keep_unicode_dates_titles_namespace_and_exact_history_anchor() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let f = Fixture::new("http://127.0.0.1:1/v1", None).await;
        let session = imported(&f, "A café conversation", &f.owner.prefix, "The original café answer").await;
        let foreign = imported(&f, "Foreign conversation", "other_", "The original café answer").await;
        let found = f.query("recall", json!({"terms":["CAFÉ"],"since":1000,"until":2000})).await.unwrap();
        assert_eq!(found["complete"], true, "{found}");
        assert_eq!(found["titles"], json!([]));
        let passages = found["passages"].as_array().unwrap();
        assert_eq!(passages.len(), 1, "{found}");
        let hit = &passages[0];
        assert_eq!(hit["session"]["id"], session);
        let through = f.query("observe", json!({"sessionId":session})).await.unwrap()["through"].clone();
        let page = f.query("history", json!({"sessionId":session,"through":through,"position":{"kind":"row","position":hit["anchorPosition"],"field":"body"}})).await.unwrap();
        assert_eq!(page["chunks"][0]["messageId"], hit["anchorMessageId"]);
        assert!(page["chunks"][0]["text"].as_str().unwrap().contains("café"));
        let title = f.query("recall", json!({"terms":["conversation"],"session_id":session})).await.unwrap();
        assert_eq!(title["titles"][0]["id"], session);
        assert_eq!(f.query("recall", json!({"terms":["café"],"since":4000})).await.unwrap()["passages"], json!([]));
        assert!(f.query("recall", json!({"terms":["café"],"session_id":foreign})).await.is_err());
        assert!(f.app.client().start(f.binding(2).await, "recall".into(), json!({"terms":["café"]}), scope(&f.issuer,false), Attachments::new().into()).await.is_err());
        assert!(f.query("recall", json!({"terms":[],"since":2000,"until":1000})).await.is_err());
        let long = format!("needle cafe\u{301} {}\n终点", "字".repeat(6000));
        let mut long_session = String::new();
        for index in 0..12 {
            let answer = if index == 11 { long.as_str() } else { "needle short answer" };
            let id = imported(&f, &format!("needle title {index}"), &f.owner.prefix, answer).await;
            if index == 11 { long_session = id; }
        }
        let found = f.query("recall", json!({"terms":["needle"]})).await.unwrap();
        assert_eq!(found["complete"], true, "{found}");
        assert_eq!(found["titles"].as_array().unwrap().len(), 24, "both seed and imported titles remain searchable");
        let passages = found["passages"].as_array().unwrap();
        assert_eq!(passages.len(), 12, "title matches must not consume an implicit passage budget");
        let hit = passages.iter().find(|hit| hit["session"]["id"] == long_session).unwrap();
        assert_eq!(hit["excerpt"], long, "the full source anchor preserves Unicode and its tail");
        let through = f.query("observe", json!({"sessionId":long_session})).await.unwrap()["through"].clone();
        let page = f.query("history", json!({"sessionId":long_session,"through":through,"position":{"kind":"row","position":hit["anchorPosition"],"field":"body"}})).await.unwrap();
        assert_eq!(page["chunks"][0]["messageId"], hit["anchorMessageId"]);
        assert_eq!(page["chunks"][0]["totalBytes"], long.len());
        let limited = f.query("recall", json!({"terms":["needle"],"since":0,"limit":3})).await.unwrap();
        assert_eq!(limited["titles"], json!([]));
        assert_eq!(limited["passages"].as_array().unwrap().len(), 3);
        f.app.shutdown().await.unwrap();
    }).await.unwrap();
}
pub(super) async fn tool(socket: &mut TcpStream, name: &str, input: Value) {
    let delta = json!({"id":"recall-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":format!("call-{}",Uuid::new_v4()),"type":"function","function":{"name":name,"arguments":input.to_string()}}]},"finish_reason":null}]});
    let end = json!({"id":"recall-model","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]});
    let body = format!("data: {delta}\n\ndata: {end}\n\ndata: [DONE]\n\n");
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
}
#[tokio::test]
async fn recall_native_model_tools_expand_exclude_active_turn_and_retain_material_copy() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Fixture::configured(&format!("http://{}/v1",listener.local_addr().unwrap()),None,None,None,|settings| settings.recall=true).await;
        images::enable_vision(&f).await;
        let source = imported(&f, "Earlier conversation", &f.owner.prefix, "The original café answer").await;
        let found = f.query("recall",json!({"terms":["café"],"session_id":source})).await.unwrap();
        let anchor = found["passages"][0]["anchorMessageId"].clone();
        let bytes = b"historical attachment contents\nsecond line";
        let uploaded = attachments::upload(&f,&source,"notes.txt",bytes,Uuid::new_v4()).await.unwrap();
        let artifact = uploaded["attachment"]["id"].as_str().unwrap().to_owned();
        use base64::Engine as _;
        let image_bytes = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQNE5uAAACKAEoAfdvjgAAAABJRU5ErkJggg==").unwrap();
        let image = attachments::upload(&f,&source,"image.png",&image_bytes,Uuid::new_v4()).await.unwrap()["attachment"]["id"].as_str().unwrap().to_owned();
        let target = f.create("Current conversation").await;
        let started = f.mutation(2,"send",json!({"sessionId":target,"message":"café current turn must be excluded","model":f.selection().await}),Uuid::new_v4()).await.unwrap();
        assert_eq!(started["kind"],"started");
        for (name,input,previous) in [
            ("Recall",json!({"terms":["café","second","third","fourth","fifth","sixth","seventh","eighth","ninth"],"question":"original question ".repeat(40),"limit":26}), None),
            ("RecallMore",json!({"session_id":source,"anchor_message_id":anchor,"before":9,"after":9}), Some("original café answer")),
            ("RecallMaterial",json!({"session_id":source,"artifact_id":artifact}), Some("A later exchange")),
            ("RecallMaterial",json!({"session_id":source,"artifact_id":image}), Some("historical attachment contents")),
        ] {
            let (mut socket,_) = listener.accept().await.unwrap();
            let sent = request(&mut socket).await;
            assert!(sent["tools"].as_array().unwrap().iter().any(|t| t["function"]["name"] == name));
            if let Some(expected) = previous {
                let result = sent["messages"].as_array().unwrap().iter().rev().find(|m| m["role"] == "tool").unwrap()["content"].as_str().unwrap();
                assert!(result.contains(expected),"{result}");
                assert!(!result.contains("current turn must be excluded"));
            }
            tool(&mut socket,name,input).await;
        }
        let (mut socket,_) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        assert!(sent.to_string().contains("data:image/png;base64,"),"{sent}");
        response(&mut socket).await;
        f.drained().await;
        let facts = service_tools::facts(&f,&target).await;
        assert_eq!(facts.iter().filter(|fact| matches!(fact,Fact::ToolSettled { outcome: ToolOutcome::Succeeded { .. }, .. })).count(),4,"{facts:?}");
        // Context checkpoints replace active model input, not original Recall material.
        let compacted = f.mutation(2,"compact",json!({"sessionId":target,"model":f.selection().await}),Uuid::new_v4()).await.unwrap();
        assert_eq!(compacted["kind"],"started");
        let (mut socket,_) = listener.accept().await.unwrap();
        request(&mut socket).await;
        response_with_text(&mut socket,"A short overview without the original tool result.").await;
        f.drained().await;
        assert!(service_tools::facts(&f,&target).await.iter().any(|fact| matches!(fact,Fact::ContextCheckpointRecorded { .. })));
        let mut history_input = json!({"sessionId":target,"position":{"kind":"start"}});
        let mut historical_tools = String::new();
        loop {
            let page = f.query("history",history_input.clone()).await.unwrap();
            history_input["through"] = page["through"].clone();
            assert_eq!(page["kind"], "ready");
            for chunk in page["chunks"].as_array().unwrap() {
                if matches!(chunk["role"].as_str(),Some("tool_call" | "tool_result")) {
                    historical_tools.push_str(chunk["text"].as_str().unwrap());
                }
            }
            if page["after"].is_null() { break; }
            history_input["position"] = json!({"kind":"after","cursor":page["after"]});
        }
        assert!(historical_tools.contains("historical attachment contents"),"{historical_tools}");
        let copies = f.session(&target).await.list_artifacts(&target,0,128).await.unwrap();
        let copied = copies.records.iter().find(|record| record.name == "notes.txt").unwrap();
        assert_ne!(copied.id,artifact);
        assert!(matches!(f.session(&source).await.delete_user_artifact(&source,&artifact).await.unwrap(), maka_event_log::artifacts::ArtifactDeletion::Deleted));
        assert_eq!(f.session(&target).await.read_artifact_chunk(&target,&copied.id,0,1024).await.unwrap().unwrap().bytes,bytes);
        f.app.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn recall_native_privacy_revokes_offered_tools_and_pending_queries() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Fixture::configured(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
            None,
            None,
            |settings| settings.recall = true,
        )
        .await;
        let source = imported(
            &f,
            "Private source",
            &f.owner.prefix,
            "The original café answer",
        )
        .await;
        let target = f.create("Privacy transition").await;
        let query = json!({"terms":["café"],"session_id":source});
        assert_eq!(
            f.query("recall", query.clone()).await.unwrap()["passages"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        f.send(&target).await.unwrap();
        let (mut offered, _) = listener.accept().await.unwrap();
        let sent = request(&mut offered).await;
        for name in ["Recall", "RecallMore", "RecallMaterial"] {
            assert!(
                sent["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|tool| tool["function"]["name"] == name)
            );
        }
        let before = f.config.runtime_policy().await.unwrap();
        assert!(matches!(
            f.config
                .set_privacy(
                    before.revision,
                    maka_agent_facts::configuration::policy::PrivacyPolicy {
                        incognito_active: true
                    }
                )
                .await
                .unwrap(),
            maka_agent_facts::configuration::policy::RuntimePolicyMutationResult::Committed { .. }
        ));
        assert!(
            f.query("recall", query.clone())
                .await
                .unwrap_err()
                .contains("privacy mode")
        );
        // The provider saw the tool before the toggle. Its late call must fail
        // execution authorization and its next request must omit all Recall tools.
        tool(&mut offered, "Recall", query.clone()).await;
        let (mut next, _) = listener.accept().await.unwrap();
        let sent = request(&mut next).await;
        assert!(!sent["tools"].as_array().into_iter().flatten().any(|tool| {
            tool["function"]["name"]
                .as_str()
                .is_some_and(|name| name.starts_with("Recall"))
        }));
        assert!(!sent.to_string().contains("original café answer"));
        response(&mut next).await;
        f.drained().await;
        let facts = service_tools::facts(&f, &target).await;
        assert!(!facts.iter().any(|fact| matches!(
            fact,
            Fact::ToolSettled {
                outcome: ToolOutcome::Succeeded { .. },
                ..
            }
        )));
        let before = f.config.runtime_policy().await.unwrap();
        f.config
            .set_privacy(
                before.revision,
                maka_agent_facts::configuration::policy::PrivacyPolicy {
                    incognito_active: false,
                },
            )
            .await
            .unwrap();
        assert_eq!(
            f.query("recall", query).await.unwrap()["passages"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        f.send(&target).await.unwrap();
        let (mut restored, _) = listener.accept().await.unwrap();
        assert!(
            request(&mut restored).await["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tool| tool["function"]["name"] == "Recall")
        );
        response(&mut restored).await;
        f.drained().await;
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

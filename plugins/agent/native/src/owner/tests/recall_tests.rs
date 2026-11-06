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
        let found = f.recall(json!({"terms":["CAFÉ"],"since":1000,"until":2000})).await.unwrap();
        assert_eq!(found["complete"], true, "{found}");
        assert_eq!(found["titles"], json!([]));
        let passages = found["passages"].as_array().unwrap();
        assert_eq!(passages.len(), 1, "{found}");
        let hit = &passages[0];
        assert_eq!(hit["session"]["id"], session);
        let through = f.query("observe", json!({"sessionId":session})).await.unwrap()["through"].clone();
        let page = f.query("history", json!({"sessionId":session,"through":through,"position":{"kind":"row","position":hit["anchorPosition"],"field":"body"}})).await.unwrap();
        assert_eq!(page["chunks"][0]["messageId"], hit["anchorMessageId"]);
        let original = page["chunks"][0]["text"].as_str().unwrap();
        assert!(original.contains("café") || original.contains("cafe\u{301}"));
        let title = f.recall(json!({"terms":["conversation"],"session_id":session})).await.unwrap();
        assert_eq!(title["titles"][0]["id"], session);
        assert_eq!(f.recall(json!({"terms":["café"],"since":4000})).await.unwrap()["passages"], json!([]));
        assert!(f.recall(json!({"terms":["café"],"session_id":foreign})).await.is_err());
        assert!(f.app.client().subscribe(f.binding(2).await, "recall".into(), json!({"terms":["café"]}), scope(&f.issuer,false), Attachments::new().into()).await.is_err());
        assert!(f.recall(json!({"terms":[],"since":2000,"until":1000})).await.is_err());
        let long = format!("needle cafe\u{301} {}\n😀终点", "字".repeat(6000));
        let mut long_session = String::new();
        for index in 0..17 {
            let answer = if index == 16 { long.as_str() } else { "needle short answer" };
            let id = imported(&f, &format!("needle title {index}"), &f.owner.prefix, answer).await;
            if index == 16 { long_session = id; }
        }
        let found = f.recall(json!({"terms":["needle"]})).await.unwrap();
        assert_eq!(found["complete"], true, "{found}");
        assert_eq!(found["titles"].as_array().unwrap().len(), 34, "both seed and imported titles remain searchable across catalog pages");
        let passages = found["passages"].as_array().unwrap();
        assert_eq!(passages.len(), 17, "title matches must not consume an implicit passage budget");
        let hit = passages.iter().find(|hit| hit["session"]["id"] == long_session).unwrap();
        let preview = hit["excerpt"].as_str().unwrap();
        assert!(preview.contains("needle"));
        assert!(preview.chars().count() < long.chars().count(), "search returns a preview while history retains the complete source");
        let through = f.query("observe", json!({"sessionId":long_session})).await.unwrap()["through"].clone();
        let page = f.query("history", json!({"sessionId":long_session,"through":through,"position":{"kind":"row","position":hit["anchorPosition"],"field":"body"}})).await.unwrap();
        assert_eq!(page["chunks"][0]["messageId"], hit["anchorMessageId"]);
        assert_eq!(page["chunks"][0]["totalBytes"], long.len());
        let ending = f.recall(json!({"terms":["终点"],"session_id":long_session})).await.unwrap();
        let endings = ending["passages"].as_array().unwrap();
        assert_eq!(endings.len(), 1);
        let ending = &endings[0];
        assert_eq!(ending["session"]["id"], long_session);
        let preview = ending["excerpt"].as_str().unwrap();
        assert!(preview.contains("😀终点"));
        let highlights = ending["highlights"].as_array().unwrap();
        assert_eq!(highlights.len(), 1);
        let start = usize::try_from(highlights[0]["start"].as_u64().unwrap()).unwrap();
        let end = usize::try_from(highlights[0]["end"].as_u64().unwrap()).unwrap();
        let utf16: Vec<_> = preview.encode_utf16().collect();
        assert_eq!(String::from_utf16(&utf16[start..end]).unwrap(), "终点");
        let limited = f.recall(json!({"terms":["needle"],"since":0,"limit":3})).await.unwrap();
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
        let complete_answer = format!("The original café answer\n{}\n完整末尾 中😀", "字".repeat(6000));
        let source = imported(&f, "Earlier conversation", &f.owner.prefix, &complete_answer).await;
        let found = f.recall(json!({"terms":["café"],"session_id":source})).await.unwrap();
        let anchor = found["passages"][0]["anchorMessageId"].clone();
        let bytes = b"historical attachment contents\nsecond line";
        let uploaded = attachments::upload(&f,&source,"notes.txt",bytes,Uuid::new_v4()).await.unwrap();
        let artifact = uploaded["attachment"]["id"].as_str().unwrap().to_owned();
        use base64::Engine as _;
        let image_bytes = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQNE5uAAACKAEoAfdvjgAAAABJRU5ErkJggg==").unwrap();
        let image = attachments::upload(&f,&source,"image.png",&image_bytes,Uuid::new_v4()).await.unwrap()["attachment"]["id"].as_str().unwrap().to_owned();
        let target = f.create("Current conversation").await;
        let started = f.mutation(2,"send",json!({"sessionId":target,"message":"café current turn must be excluded","backend":model_backend(&f.selection().await)}),Uuid::new_v4()).await.unwrap();
        assert_eq!(started["kind"],"started");
        for (name,input,previous,complete_context) in [
            ("Recall",json!({"terms":["café","second","third","fourth","fifth","sixth","seventh","eighth","ninth"],"limit":26}), None, false),
            ("RecallMore",json!({"session_id":source,"anchor_message_id":anchor,"before":9,"after":9}), Some("original café answer"), true),
            ("RecallMaterial",json!({"session_id":source,"artifact_id":artifact}), Some("A later exchange"), true),
            ("RecallMaterial",json!({"session_id":source,"artifact_id":image}), Some("historical attachment contents"), false),
        ] {
            let (mut socket,_) = listener.accept().await.unwrap();
            let sent = request(&mut socket).await;
            assert!(sent["tools"].as_array().unwrap().iter().any(|t| t["function"]["name"] == name));
            if let Some(expected) = previous {
                let result = sent["messages"].as_array().unwrap().iter().rev().find(|m| m["role"] == "tool").unwrap()["content"].as_str().unwrap();
                assert!(result.contains(expected),"{result}");
                if complete_context {
                    assert!(result.contains(&complete_answer), "Recall and RecallMore must preserve the entire source message, including its Unicode tail");
                }
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
            f.recall(query.clone()).await.unwrap()["passages"]
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
            f.recall(query.clone())
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
            f.recall(query).await.unwrap()["passages"]
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

#[tokio::test]
async fn recall_model_tool_ranks_multi_term_tool_calls_and_unlocks_mid_turn_compacted_prefix() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Fixture::configured(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
            None,
            None,
            |settings| settings.recall = true,
        )
        .await;
        let seed = f.create("Seed configuration").await;
        let configuration = f
            .session(&seed)
            .await
            .get_session::<StoredSessionConfiguration>(&seed)
            .await
            .unwrap()
            .unwrap()
            .configuration;
        let source = format!("{}{}", f.owner.prefix, Uuid::new_v4().simple());
        f.store
            .import_session(
                &PluginSession {
                    session_id: source.clone(),
                    creator: Namespace::new("recall.fixture", StorageScope::Profile).unwrap(),
                    fingerprint: source.clone(),
                    managed: false,
                    authority_session_id: None,
                },
                &Source {
                    adapter: "fixture".into(),
                    session_id: "multi-term-source".into(),
                },
                &configuration,
                vec![
                    Record {
                        source_message_id: "u1".into(),
                        source_turn_id: "one".into(),
                        timestamp: Some(1000),
                        content: Content::User {
                            text: "Run the gateway test suite".into(),
                        },
                    },
                    Record {
                        source_message_id: "tc1".into(),
                        source_turn_id: "one".into(),
                        timestamp: Some(1500),
                        content: Content::ToolCall {
                            call_id: "call-bash-1".into(),
                            name: "Bash".into(),
                            input: Some(json!({"command": "cargo test -p alpha-gateway"})),
                        },
                    },
                    Record {
                        source_message_id: "u2".into(),
                        source_turn_id: "two".into(),
                        timestamp: Some(2000),
                        content: Content::User {
                            text: "Fix alpha-gateway retry-budget timeout".into(),
                        },
                    },
                    Record {
                        source_message_id: "a2".into(),
                        source_turn_id: "two".into(),
                        timestamp: Some(2100),
                        content: Content::Assistant {
                            text: "Neighbor reply in turn two".into(),
                            thinking: None,
                            model: None,
                        },
                    },
                ],
                1,
            )
            .await
            .unwrap();

        let target = f.create("Active mid-turn session").await;
        let started = f
            .mutation(
                2,
                "send",
                json!({
                    "sessionId": target,
                    "message": "alpha-gateway retry-budget midturn-early-needle",
                    "backend": model_backend(&f.selection().await),
                }),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(started["kind"], "started");

        // Step 1: Recall with before=0, after=0 while the turn is uncompacted.
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        let recall_tool = sent["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["function"]["name"] == "Recall")
            .unwrap();
        assert!(recall_tool["function"]["parameters"]["properties"]["before"].is_object());
        assert!(recall_tool["function"]["parameters"]["properties"]["after"].is_object());
        tool(
            &mut socket,
            "Recall",
            json!({"terms": ["alpha-gateway", "retry-budget"], "before": 0, "after": 0}),
        )
        .await;

        // Step 2: Inspect first Recall result, then trigger reactive MidTurn compaction via context overflow.
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        let first_result = sent["messages"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find(|message| message["role"] == "tool")
            .unwrap()["content"]
            .as_str()
            .unwrap();
        assert!(
            !first_result.contains("midturn-early-needle"),
            "uncompacted active turn must be excluded: {first_result}"
        );
        assert!(
            first_result.contains("Ranked anchors (2):"),
            "multi-hit Recall output must prepend ranked anchor directory: {first_result}"
        );
        let multi_term_pos = first_result
            .find("Fix alpha-gateway retry-budget timeout")
            .unwrap();
        let single_term_tool_pos = first_result
            .find("Bash\ncommand: cargo test -p alpha-gateway")
            .unwrap();
        assert!(
            multi_term_pos < single_term_tool_pos,
            "2-term match must outrank 1-term ToolCall match: {first_result}"
        );
        assert!(
            !first_result.contains("Neighbor reply in turn two"),
            "before=0, after=0 must omit neighbor message bodies: {first_result}"
        );
        assert!(
            first_result.contains("More before: true; more after: true"),
            "before=0, after=0 must still report accurate neighbor availability: {first_result}"
        );
        let overflow = json!({
            "error": {
                "message": "request exceeds context",
                "type": "invalid_request_error",
                "code": "context_length_exceeded"
            }
        })
        .to_string();
        socket
            .write_all(
                format!(
                    "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{overflow}",
                    overflow.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();

        // Step 3: Serve automatic MidTurn summary generation.
        let (mut summary_socket, _) = listener.accept().await.unwrap();
        let summary_req = request(&mut summary_socket).await;
        assert_eq!(summary_req["tool_choice"], "auto");
        response_with_text(
            &mut summary_socket,
            "Compacted mid-turn handoff without original token.",
        )
        .await;

        // Step 4: Resumed active turn after MidTurn checkpoint can now Recall its compacted prefix,
        // while excluding post-checkpoint live messages in the same turn.
        let (mut socket, _) = listener.accept().await.unwrap();
        let resumed = request(&mut socket).await;
        let resumed_messages = resumed["messages"].to_string();
        assert!(!resumed_messages.contains("midturn-early-needle"));
        assert!(resumed_messages.contains("Compacted mid-turn handoff without original token."));
        tool(
            &mut socket,
            "Recall",
            json!({
                "terms": ["midturn-early-needle", "post-checkpoint-live-arg"],
                "session_id": target,
                "before": 0,
                "after": 0
            }),
        )
        .await;

        // Step 5: Verify compacted prefix was found and live post-checkpoint ToolCall was excluded,
        // then expand via RecallMore and verify expansion stops at covered_through.
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        let second_result = sent["messages"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find(|message| message["role"] == "tool")
            .unwrap()["content"]
            .as_str()
            .unwrap();
        assert!(
            second_result.contains("midturn-early-needle"),
            "compacted MidTurn prefix must be searchable in Recall: {second_result}"
        );
        assert!(
            !second_result.contains("post-checkpoint-live-arg"),
            "uncompacted live tail after MidTurn checkpoint must remain excluded: {second_result}"
        );
        let anchor_id = second_result
            .lines()
            .find_map(|line| line.strip_prefix("Anchor: "))
            .unwrap()
            .trim()
            .to_owned();
        tool(
            &mut socket,
            "RecallMore",
            json!({
                "session_id": target,
                "anchor_message_id": anchor_id,
                "before": 0,
                "after": 10
            }),
        )
        .await;

        // Step 6: Verify RecallMore expands compacted MidTurn neighbors up to covered_through only.
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        let expanded = sent["messages"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find(|message| message["role"] == "tool")
            .unwrap()["content"]
            .as_str()
            .unwrap();
        assert!(expanded.contains("midturn-early-needle"), "{expanded}");
        assert!(
            expanded.contains("Recall\nterms: alpha-gateway\nterms: retry-budget\nbefore: 0\nafter: 0"),
            "{expanded}"
        );
        assert!(
            expanded.contains("Fix alpha-gateway retry-budget timeout"),
            "{expanded}"
        );
        assert!(
            !expanded.contains("post-checkpoint-live-arg"),
            "RecallMore must not cross covered_through into the live turn tail: {expanded}"
        );
        assert!(
            expanded.contains("More before: false; more after: false"),
            "{expanded}"
        );
        response(&mut socket).await;
        f.drained().await;

        let facts = service_tools::facts(&f, &target).await;
        assert!(facts.iter().any(|fact| matches!(
            fact,
            Fact::ContextCheckpointRecorded { checkpoint }
                if matches!(
                    checkpoint.mode,
                    maka_agent_facts::context::CheckpointMode::MidTurn { .. }
                )
        )));
        f.app.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn recall_and_catalog_isolate_unreadable_historical_sessions_and_events() {
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
        let healthy = imported(
            &f,
            "Healthy needle conversation",
            &f.owner.prefix,
            "Healthy needle answer",
        )
        .await;
        let legacy_config = imported(
            &f,
            "Legacy needle config",
            &f.owner.prefix,
            "Legacy needle body",
        )
        .await;
        let corrupt_events = imported(
            &f,
            "Corrupt needle events",
            &f.owner.prefix,
            "Corrupt needle event body",
        )
        .await;

        // Pre-index legacy_config so recall_messages has hits whose session metadata is unreadable,
        // exercising both catalog/title isolation and hit-metadata isolation.
        assert_eq!(
            f.recall(json!({"terms":["needle"],"session_id":legacy_config}))
                .await
                .unwrap()["passages"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        {
            let db = rusqlite::Connection::open(f.session_database(&legacy_config)).unwrap();
            db.execute(
                "UPDATE session_control SET configuration=json_set(configuration,'$.workspace',json('{\"kind\":\"inline_legacy\"}')) WHERE id=?1",
                [&legacy_config],
            )
            .unwrap();
        }
        {
            let db = rusqlite::Connection::open(f.session_database(&corrupt_events)).unwrap();
            db.execute(
                "UPDATE event_log
                 SET event_header = json_set(event_header, '$.fact.kind', 'legacy_removed_fact'),
                     canonical_bytes = length(CAST(json_set(event_header, '$.fact.kind', 'legacy_removed_fact') AS BLOB))
                 WHERE event_session = ?1 AND body_id IS NULL AND event_header IS NOT NULL",
                [&corrupt_events],
            )
            .unwrap();
        }

        let found = f.recall(json!({"terms":["needle"]})).await.unwrap();
        assert_eq!(found["complete"], false, "{found}");
        let title_ids: Vec<_> = found["titles"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["id"].as_str().unwrap())
            .collect();
        assert!(title_ids.contains(&healthy.as_str()), "{found}");
        assert!(title_ids.contains(&corrupt_events.as_str()), "{found}");
        assert!(!title_ids.contains(&legacy_config.as_str()), "{found}");
        let passage_ids: Vec<_> = found["passages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["session"]["id"].as_str().unwrap())
            .collect();
        assert_eq!(passage_ids, vec![healthy.as_str()], "{found}");
        let gaps: Vec<_> = found["gaps"]
            .as_array()
            .unwrap()
            .iter()
            .map(|gap| gap.as_str().unwrap())
            .collect();
        assert!(
            gaps.iter().any(|gap| gap.contains(&legacy_config)),
            "{gaps:?}"
        );
        assert!(
            gaps.iter().any(|gap| gap.contains(&corrupt_events)),
            "{gaps:?}"
        );

        let scoped_healthy = f
            .recall(json!({"terms":["needle"],"session_id":healthy}))
            .await
            .unwrap();
        assert_eq!(scoped_healthy["complete"], true, "{scoped_healthy}");
        assert_eq!(scoped_healthy["gaps"], json!([]), "{scoped_healthy}");
        assert!(
            f.recall(json!({"terms":["needle"],"session_id":legacy_config}))
                .await
                .is_err()
        );

        let listed = f
            .query(
                "list",
                json!({
                    "filter": "all",
                    "rootsOnly": false,
                    "scope": {"kind": "all"},
                    "position": {"kind": "start"}
                }),
            )
            .await
            .unwrap();
        let listed_ids: Vec<_> = listed["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["id"].as_str().unwrap())
            .collect();
        assert!(listed_ids.contains(&healthy.as_str()), "{listed}");
        assert!(!listed_ids.contains(&legacy_config.as_str()), "{listed}");

        let caller = f.create("Caller conversation").await;
        let started = f
            .mutation(
                2,
                "send",
                json!({
                    "sessionId": caller,
                    "message": "Search earlier needle notes",
                    "backend": model_backend(&f.selection().await)
                }),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(started["kind"], "started");
        let (mut socket, _) = listener.accept().await.unwrap();
        let _ = request(&mut socket).await;
        tool(&mut socket, "Recall", json!({"terms": ["needle"]})).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        let tool_output = sent["messages"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find(|message| message["role"] == "tool")
            .unwrap()["content"]
            .as_str()
            .unwrap();
        assert!(tool_output.contains("Healthy needle answer"), "{tool_output}");
        assert!(tool_output.contains(&corrupt_events), "{tool_output}");
        response(&mut socket).await;
        f.drained().await;
        f.app.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

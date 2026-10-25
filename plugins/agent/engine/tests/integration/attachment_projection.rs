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

use maka_agent_engine::project_model_history;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::input::DeliveredMessage;
use maka_agent_facts::input::InvocationInput;
use maka_agent_facts::input::MessageInput;
use maka_event_log::EventLog;
use serde_json::json;

#[tokio::test]
async fn attachment_references_remain_structured_after_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("runtime.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let attachments = [
        json!([{"kind":"image","name":"😀 <image> \"name\"","mimeType":"image/png","bytes":8,
            "ref":{"kind":"session_file","sessionId":"session0","relativePath":"image-id"}},
            {"kind":"pdf","name":"report.pdf","mimeType":"application/pdf","bytes":100,
            "ref":{"kind":"session_file","sessionId":"session0","relativePath":"pdf-id"}}]),
        json!([{"kind":"code","name":"source.rs","mimeType":"text/plain","bytes":10,
            "ref":{"kind":"workspace_file","relativePath":"src/file.rs"}},
            {"kind":"other","name":"external","mimeType":"text/plain","bytes":1,
            "ref":{"kind":"external_file","absolutePath":"/tmp/file"}},
            {"kind":"other","name":"not-opaque","mimeType":"text/plain","bytes":1,
            "ref":{"kind":"session_file","sessionId":"session1","relativePath":"folder/file"}}]),
        json!([]),
    ];
    let mut cases = Vec::new();
    for (index, attachments) in attachments.into_iter().enumerate() {
        let session = format!("session{index}");
        let input: MessageInput = serde_json::from_value(json!({
            "text":"original question", "display_text":"visible chips",
            "attachments":attachments,
            "quotes":[{"text":"quoted <data>","label":"label", "source": {
                "sessionId":"source", "sessionName":"Research <&> 😀", "capturedAt":1234.5, "truncated":true
            }}],
            "directory_references":[{"hostId":"root","path":"/tmp/<folder>"}],
            "inline_references":[]
        }))
        .unwrap();
        log.append(
            &maka_agent_facts::event::EventWrite::plain(RuntimeEvent::new(
                Invocation {
                    session_id: session.clone(),
                    turn_id: format!("turn{index}"),
                    run_id: format!("run{index}"),
                    invocation_id: format!("invocation{index}"),
                },
                Fact::InvocationOpened {
                    configuration: None,
                    input: InvocationInput::Message {
                        source_messages: Vec::new(),
                        content: input.clone(),
                        request_fingerprint: None,
                    },
                },
            ))
            .unwrap(),
        )
        .await
        .unwrap();
        let steering = RuntimeEvent::new(
            Invocation {
                session_id: session.clone(),
                turn_id: format!("turn{index}"),
                run_id: format!("run{index}"),
                invocation_id: format!("invocation{index}"),
            },
            {
                let message = DeliveredMessage {
                    origin: None,
                    message_id: "same-client-id".into(),
                    content: input.clone(),
                    submitted_content_digest: format!("sha256:{}", "a".repeat(64)),
                };
                let mut unprepared_content = message.content.clone();
                unprepared_content.preparation.clear();
                Fact::MessageSteered {
                    source: Box::new(maka_agent_facts::message::RootSourceMessage {
                        message: message.clone(),
                        unprepared_content,
                        submitted_placement: maka_agent_facts::message::Placement::CurrentTurn,
                        disposition: maka_agent_facts::message::MessageDisposition::Steering,
                        submitted_intent: None,
                    }),
                    message: Box::new(message),
                }
            },
        );
        log.append(&maka_agent_facts::event::EventWrite::plain(steering).unwrap())
            .await
            .unwrap();
        let prefix = log
            .scoped_prefix(
                maka_agent_facts::event::LogScope::Session {
                    id: session.clone(),
                },
                10,
                32 * 1024,
            )
            .await
            .unwrap();
        let model = serde_json::to_value(
            project_model_history(&prefix, &session, maka_agent_facts::language::Language::En)
                .unwrap(),
        )
        .unwrap();
        let text = model[0]["content"][0]["text"].as_str().unwrap();
        let mut view = maka_presentation::InvocationView::new();
        let rows = view.push(&prefix.events[0]).unwrap();
        let user = serde_json::to_value(&rows[0].message).unwrap();
        let steered = view.push(&prefix.events[1]).unwrap();
        let steered = serde_json::to_value(&steered[0].message).unwrap();
        assert_eq!(steered["id"], "same-client-id");
        assert_eq!(steered["text"], input.text);
        assert_eq!(steered["attachments"], attachments);
        assert_eq!(
            model.as_array().unwrap().len(),
            2,
            "equal text has two distinct message identities"
        );
        assert_eq!(user["attachments"], attachments);
        assert_eq!(user["text"], input.text);
        assert_eq!(user["displayText"], input.display_text.as_deref().unwrap());
        let suffix: MessageInput = serde_json::from_value(json!({
            "text": "😀 @file", "display_text": null,
            "inline_references": [{"kind":"workspace_file","value":"@file","label":"file","start":3}]
        })).unwrap();
        let aggregate_sources = [input.clone(), suffix];
        let aggregated = maka_agent_facts::message::aggregate(aggregate_sources.iter());
        cases.push(
            json!({"session":session,"input":serde_json::to_value(&input).unwrap(),
            "steering":model[1]["content"][0]["text"],
            "aggregation":{"sources":aggregate_sources,"expected":aggregated},
            "content":{"text":input.text,"attachments":attachments,"quotes":input.quotes,
                "directoryReferences":input.directory_references},"text":text}),
        );
    }
    let before = serde_json::to_vec(&log.prefix(10, 128 * 1024).await.unwrap()).unwrap();
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(
        serde_json::to_vec(&log.prefix(10, 128 * 1024).await.unwrap()).unwrap(),
        before
    );
    for case in &cases {
        let session = case["session"].as_str().unwrap();
        let prefix = log
            .scoped_prefix(
                maka_agent_facts::event::LogScope::Session { id: session.into() },
                10,
                32 * 1024,
            )
            .await
            .unwrap();
        let Fact::InvocationOpened {
            input: InvocationInput::Message { content, .. },
            ..
        } = &prefix.events[0].event.fact
        else {
            panic!("canonical user input");
        };
        assert_eq!(serde_json::to_value(content).unwrap(), case["input"]);
        assert_eq!(
            serde_json::to_value(
                project_model_history(&prefix, session, maka_agent_facts::language::Language::En)
                    .unwrap()
            )
            .unwrap()[0]["content"][0]["text"],
            case["text"]
        );
        assert_eq!(
            serde_json::to_value(
                project_model_history(&prefix, session, maka_agent_facts::language::Language::En)
                    .unwrap()
            )
            .unwrap()[1]["content"][0]["text"],
            case["steering"]
        );
    }
    log.close().await.unwrap();
}

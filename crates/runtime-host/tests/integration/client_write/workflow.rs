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

use super::super::support::{
    client_probe::ClientFixture,
    message_recovery::{Provider, configure},
    peer::Peer,
};
use maka_client::{Client, Notification};
use maka_protocol::{
    Operation,
    subscription::{
        ObservationFrame, SessionProjectionFrame, SubscriptionOpenInput, ToolObservationFrame,
        TranscriptAdvancedFrame, TranscriptPolicy,
    },
    transcript::{SessionTranscriptPageDirection, SessionTranscriptPageInput},
};
use maka_runtime_host::server::{Host, HostOperations, local::LocalListener};
use serde_json::{Value, json};
use std::{collections::HashSet, time::Duration};
use tokio_util::sync::CancellationToken;

const CONTENT: &str = "written 😀 中文\n";
const EDITED: &str = "edited $& 😀\n";
const SESSIONS: [&str; 2] = ["write-ask", "write-explore"];

pub(super) async fn run(fixture: &ClientFixture, reopened: bool) -> (Vec<Value>, Vec<Value>) {
    let (provider, mut requests) = Provider::controlled().await;
    let model = if reopened {
        None
    } else {
        std::fs::write(fixture.workspace.join("sentinel.txt"), "UNCHANGED").unwrap();
        Some(configure(fixture, &provider.base_url).await)
    };
    let host =
        Host::open_with_global_instructions(fixture.owner(), Some(fixture.workspace.join(".maka")))
            .await
            .unwrap();
    let (mut peer, hello) = Peer::handshake(host.clone(), "write-identity").await;
    peer.wait_for_plugins().await;
    peer.close().await;
    #[cfg(unix)]
    let endpoint = fixture.workspace.parent().unwrap().join("h.sock");
    #[cfg(windows)]
    let endpoint =
        std::path::PathBuf::from(format!(r"\\.\pipe\maka-write-{}", uuid::Uuid::new_v4()));
    let cancel = CancellationToken::new();
    let listener = LocalListener::bind(&endpoint).unwrap();
    let server = tokio::spawn(listener.serve(host, cancel.clone()));
    let (client, mut notices) = Client::connect(
        maka_client::local::open_stream(&endpoint).await.unwrap(),
        hello["rootId"].as_str().unwrap(),
        hello["hostEpoch"].as_str().unwrap(),
        HostOperations,
    )
    .await
    .unwrap();
    let expected = results(fixture);
    let script_results = expected.clone();
    let script = tokio::spawn(async move {
        if reopened {
            return;
        }
        let actions = [
            Some(("Write", json!({"path":"written.txt","content":CONTENT}))),
            Some((
                "Edit",
                json!({"path":"written.txt","old_string":CONTENT,"new_string":EDITED}),
            )),
            Some(("Glob", json!({"pattern":"written.*"}))),
            Some(("Grep", json!({"pattern":"^edited","path":"written.txt"}))),
            Some(("Read", json!({"path":"written.txt"}))),
            None,
            Some(("Write", json!({"path":"sentinel.txt","content":CONTENT}))),
            None,
        ];
        for (index, action) in actions.into_iter().enumerate() {
            let request = tokio::time::timeout(Duration::from_secs(15), requests.recv())
                .await
                .unwrap()
                .unwrap();
            let tools = request.body["tools"].as_array().unwrap();
            assert!(tools.iter().any(|tool| tool["function"]["name"] == "Read"));
            for name in ["Write", "Edit"] {
                assert_eq!(
                    tools.iter().any(|tool| tool["function"]["name"] == name),
                    index < 6
                );
            }
            if (1..=5).contains(&index) || index == 7 {
                let result = request.body["messages"].as_array().unwrap().last().unwrap();
                assert_eq!(result["role"], "tool");
                assert_eq!(result["tool_call_id"], "provider:reused");
                if index == 7 {
                    assert_eq!(result["content"], "tool is unavailable");
                } else {
                    let actual: Value =
                        serde_json::from_str(result["content"].as_str().unwrap()).unwrap();
                    assert_eq!(actual, script_results[index - 1]);
                }
            }
            let (delta, finish) = match action {
                Some((name, args)) => (
                    json!({"tool_calls":[{"index":0,"id":"provider:reused","type":"function",
                        "function":{"name":name,"arguments":args.to_string()}}]}),
                    "tool_calls",
                ),
                None => (json!({"content":"mutations verified"}), "stop"),
            };
            request
                .reply
                .send(json!({"index":0,"delta":delta,"finish_reason":finish}))
                .unwrap();
        }
    });
    let mut rows = Vec::new();
    let mut events = Vec::new();
    for session in SESSIONS {
        if let Some(model) = &model {
            let input = json!({"sessionId":session,
                "workspace":{"kind":"host_path","path":fixture.workspace},
                "modelTarget":{"kind":"explicit","connectionId":model.connection_id,
                    "connectionSlug":model.connection_slug,"model":model.model},
                "sandboxMode":if session == SESSIONS[0] {"workspace-write"} else {"read-only"}});
            client
                .request(Operation::SessionCreate, input)
                .await
                .unwrap();
            let opened = client
                .open_subscription(SubscriptionOpenInput {
                    session_id: session.into(),
                    transcript: TranscriptPolicy::Tail { max_bytes: 2 },
                })
                .await
                .unwrap();
            client
                .ready_subscription(&opened.subscription_id)
                .await
                .unwrap();
            client.request(Operation::TurnStart, json!({
                "sessionId":session,"turnId":session,"content":{"text":session},"maxSteps":6,
            })).await.unwrap();
            let mut fences = Vec::new();
            tokio::time::timeout(Duration::from_secs(20), async {
                loop {
                    let Notification::Observation(frame) = notices.recv().await.unwrap() else {
                        continue;
                    };
                    if frame.envelope().subscription_id != opened.subscription_id {
                        continue;
                    }
                    match *frame {
                        ObservationFrame::Tool(ToolObservationFrame::SessionEvent {
                            event,
                            ..
                        }) => {
                            events.push(serde_json::to_value(event).unwrap());
                        }
                        ObservationFrame::Transcript(
                            TranscriptAdvancedFrame::TranscriptAdvanced {
                                through_sequence, ..
                            },
                        ) => fences.push(through_sequence),
                        ObservationFrame::Projection(frame) => {
                            let SessionProjectionFrame::SessionProjection { snapshot, .. } = *frame;
                            let turn = serde_json::to_value(snapshot.root_turn).unwrap();
                            if turn["turnId"] == session
                                && matches!(
                                    turn["status"].as_str(),
                                    Some("completed" | "failed" | "cancelled")
                                )
                            {
                                assert_eq!(turn["status"], "completed", "{turn}");
                                break;
                            }
                        }
                        _ => {}
                    }
                }
            })
            .await
            .unwrap();
            assert!(fences.len() > 1);
            assert!(fences.windows(2).all(|pair| pair[0] < pair[1]));
            client
                .close_subscription(&opened.subscription_id)
                .await
                .unwrap();
        }
        rows.extend(read_rows(&client, session).await);
    }
    script.await.unwrap();
    assert_eq!(
        provider.requests.lock().unwrap().len(),
        if reopened { 0 } else { 8 }
    );
    client.disconnect();
    cancel.cancel();
    tokio::time::timeout(Duration::from_secs(10), server)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(fixture.workspace.join("written.txt")).unwrap(),
        EDITED
    );
    assert_eq!(
        std::fs::read_to_string(fixture.workspace.join("sentinel.txt")).unwrap(),
        "UNCHANGED"
    );
    if !reopened {
        verify(&rows, &events, &expected);
    }
    (rows, events)
}

fn results(fixture: &ClientFixture) -> Vec<Value> {
    let path = fixture
        .workspace
        .canonicalize()
        .unwrap()
        .join("written.txt");
    let input: maka_runtime::read::ReadInput =
        serde_json::from_value(json!({"path":"written.txt"})).unwrap();
    vec![
        json!({"kind":"file_write","path":path,"bytes":CONTENT.len(),"previousContent":""}),
        json!({"ok":true,"path":path,"replacements":1,"matchedVia":"exact","startLine":1,"endLine":1}),
        json!({"files":["written.txt"],"complete":true}),
        json!({"matches":["1:edited $& 😀"],"complete":true}),
        serde_json::to_value(input.resolve().unwrap().page(EDITED).unwrap()).unwrap(),
    ]
}

async fn read_rows(client: &Client, session: &str) -> Vec<Value> {
    // Start inside a UTF-8 message, then exercise real fragment continuation and older pages.
    let opened = client
        .open_subscription(SubscriptionOpenInput {
            session_id: session.into(),
            transcript: TranscriptPolicy::Tail { max_bytes: 2 },
        })
        .await
        .unwrap();
    let mut page = opened.transcript.unwrap().durable;
    let mut rows = Vec::new();
    loop {
        let mut batch = client
            .complete_transcript_page(&opened.subscription_id, page)
            .await
            .unwrap();
        batch.rows.extend(rows);
        rows = batch.rows;
        let Some(cursor) = batch.next_cursor else {
            break;
        };
        page = client
            .transcript_page(SessionTranscriptPageInput {
                subscription_id: opened.subscription_id.clone(),
                direction: SessionTranscriptPageDirection::Older,
                through_sequence: batch.through_sequence,
                cursor: Some(cursor),
                anchor_sequence: None,
                max_bytes: 512 * 1024,
            })
            .await
            .unwrap();
    }
    client
        .close_subscription(&opened.subscription_id)
        .await
        .unwrap();
    rows.into_iter().map(|row| row.value).collect()
}

fn verify(rows: &[Value], events: &[Value], expected: &[Value]) {
    let calls: Vec<_> = rows
        .iter()
        .filter(|row| row["type"] == "tool_call")
        .collect();
    let results: Vec<_> = rows
        .iter()
        .filter(|row| row["type"] == "tool_result")
        .collect();
    assert_eq!(
        calls
            .iter()
            .map(|row| row["toolName"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["Write", "Edit", "Glob", "Grep", "Read", "Write"]
    );
    assert_eq!(results.len(), 6);
    assert_eq!(events.len(), 12);
    assert_eq!(
        rows.iter()
            .map(|row| row["id"].as_str().unwrap())
            .collect::<HashSet<_>>()
            .len(),
        rows.len()
    );
    for (index, (call, result)) in calls.iter().zip(&results).enumerate() {
        assert_eq!(call["origin"], "provider");
        assert_eq!(call["modelVisibility"], "visible");
        assert_eq!(result["toolUseId"], call["id"]);
        assert_eq!(result["isError"], index == 5);
        if index < 5 {
            assert_eq!(
                result["content"],
                json!({"kind":"json","value":expected[index]})
            );
        }
        let start = events
            .iter()
            .find(|event| event["type"] == "tool_start" && event["toolUseId"] == call["id"])
            .unwrap();
        let end = events
            .iter()
            .find(|event| event["type"] == "tool_result" && event["toolUseId"] == call["id"])
            .unwrap();
        assert_eq!(start["id"], call["id"]);
        assert_eq!(end["id"], result["id"]);
        assert_eq!(end["ts"], result["ts"]);
        assert_eq!(
            end["status"],
            if index == 5 { "errored" } else { "completed" }
        );
    }
    for event in events {
        for field in [
            "origin",
            "modelVisibility",
            "parentToolCallId",
            "parentOperationId",
            "args",
            "content",
        ] {
            assert!(event.get(field).is_none());
        }
    }
}

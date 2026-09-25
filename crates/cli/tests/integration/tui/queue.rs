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
use maka_client::Client;
use maka_protocol::{
    message::ExecutionResolution,
    session::decode_session_create_input,
    subscription::{SessionObservationSnapshot, SubscriptionOpenInput, TranscriptPolicy},
};
use serde_json::{Value, json};
use tokio::{io::AsyncWriteExt, sync::oneshot};

const ROOT_TASK: &str = "root task\npasted 中文🦀\nshift line\nfallback line";

#[test]
fn real_host_queue_edits_retracts_promotes_and_steers_at_the_model_boundary() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("read.txt"), "queue fixture").unwrap();
    let mut host = super::super::candidate::CandidateFixture::new(directory.path().join("root"));
    host.child = Some(
        Command::new(env!("CARGO_BIN_EXE_maka"))
            .args(["host", "serve", "--root"])
            .arg(&host.root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    host.wait_for_registration();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let (url, release_first, release_second, model) =
        runtime.block_on(provider(directory.path().join("read.txt")));
    let client = runtime.block_on(async {
        let client = support::model_client(&host.root, &url).await;
        client.create_session(decode_session_create_input(&json!({
            "sessionId":"queue-session","name":"Queue fixture session",
            "workspace":{"kind":"host_path","path":directory.path()},"sandboxMode":"read-only",
            "modelTarget":{"kind":"default"}
        })).unwrap()).await.unwrap();
        client
    });
    let mut tui = Pty::spawn_at(
        &["--root", host.root.to_str().unwrap()],
        Some(directory.path()),
    );
    tui.wait_for("Queue fixture session");
    tui.click_text("Queue fixture session");
    tui.wait_for("Message…");
    tui.send("\x1b[200~root task\npasted 中文🦀\x1b[201~".as_bytes());
    tui.send(b"\x1b[13;2ushift line\x0afallback line");
    tui.wait_for("fallback line");
    assert!(runtime.block_on(observe(&client)).root_turn.is_none());
    tui.send(b"\x1b[13;1:2u\x1b[13;1:3u"); // Repeat/release cannot submit.
    tui.send(b"\r");
    tui.wait_for("Queue gate one");
    tui.wait_for("Message…");
    let start = runtime.block_on(observe(&client));
    let root_turn = start.root_turn.unwrap();
    for text in [
        "follow-first-original",
        "remove-me",
        "promote-me",
        "follow-last",
    ] {
        tui.click_text("Message…");
        tui.send(text.as_bytes());
        tui.wait_for(text);
        if text == "remove-me" {
            tui.click_text("↳  ↗"); // Actual composer queue icon, not a queue row.
        } else {
            tui.send(b"\r");
        }
        tui.wait_for("Message…");
        runtime.block_on(wait_queue(&client, |snapshot| {
            snapshot
                .queue
                .followup
                .iter()
                .any(|entry| entry.message.content.text == text)
        }));
    }
    // Editing uses an isolated editor; save is a queue CAS, not another submit.
    tui.click_text("follow-first-original");
    tui.send(b"e");
    tui.wait_for("Edit queued message");
    tui.send("\x01\x1b[200~follow-first-edited 中文🦀\x1b[201~".as_bytes());
    tui.wait_for("follow-first-edited 中文🦀");
    tui.click_last_text("Save");
    // Drain PTY output until the canonical projection is painted before querying
    // Host facts; an unread terminal can block rendering and subsequent input.
    tui.wait_until(|screen| !screen.contains("Edit queued message"));
    tui.wait_for("↳ follow-first-edited");
    runtime.block_on(wait_queue(&client, |snapshot| {
        snapshot
            .queue
            .followup
            .iter()
            .any(|entry| entry.message.content.text == "follow-first-edited 中文🦀")
    }));
    tui.click_text("remove-me");
    tui.send(b"x");
    tui.wait_until(|screen| !screen.contains("remove-me"));
    runtime.block_on(wait_queue(&client, |snapshot| {
        !snapshot
            .queue
            .followup
            .iter()
            .any(|entry| entry.message.content.text == "remove-me")
    }));
    tui.click_text("promote-me");
    tui.send(b"s");
    tui.wait_for("↗ promote-me");
    runtime.block_on(wait_queue(&client, |snapshot| {
        snapshot
            .queue
            .steering
            .iter()
            .any(|entry| entry.message.content.text == "promote-me")
    }));
    tui.click_text("Message…");
    tui.send("direct-steering 中文🦀".as_bytes());
    tui.wait_for("direct-steering 中文🦀"); // Observe the edit before waiting for its removal.
    tui.send(b"\x0f"); // Ctrl+O does not cancel the running request.
    tui.wait_for("Message…");
    runtime.block_on(wait_queue(&client, |snapshot| {
        snapshot.queue.steering.len() == 2
    }));
    tui.wait_for("↗ direct-steering");
    tui.click_text("follow-first-edited");
    tui.send(b"\x1b[1;3B"); // Alt+Down reorders the complete follow-up lane.
    tui.wait_for("follow-last");
    let queued = runtime.block_on(wait_queue(&client, |snapshot| {
        snapshot
            .queue
            .followup
            .first()
            .is_some_and(|entry| entry.message.content.text == "follow-last")
    }));
    assert_eq!(queued.root_turn.as_ref().unwrap().run_id, root_turn.run_id);
    assert_eq!(queued.queue.followup.len(), 2);
    let followups: Vec<_> = queued
        .queue
        .followup
        .iter()
        .map(|row| row.message.message_id.clone())
        .collect();
    let steering: Vec<_> = queued
        .queue
        .steering
        .iter()
        .map(|row| row.message.message_id.clone())
        .collect();
    tui.click_text("Message…");
    tui.send("unsent survives 中文🦀".as_bytes());
    release_first.send(()).unwrap();
    tui.wait_for("Steering boundary reached");
    let stepped = runtime.block_on(observe(&client));
    assert_eq!(stepped.root_turn.as_ref().unwrap().run_id, root_turn.run_id);
    assert_eq!(
        stepped.queue.followup.len(),
        2,
        "follow-ups do not enter the running turn"
    );
    release_second.send(()).unwrap();
    tui.wait_for("Edited followup completed");
    tui.wait_for("unsent survives 中文🦀");
    let requests = runtime.block_on(model).unwrap();
    assert_eq!(requests.len(), 4);
    let ended = runtime.block_on(wait_queue(&client, |snapshot| {
        snapshot.queue.followup.is_empty()
            && snapshot.root_turn.as_ref().is_some_and(|turn| {
                matches!(turn.state, maka_protocol::turn::TurnState::Completed { .. })
            })
    }));
    assert!(ended.queue.steering.is_empty());
    runtime.block_on(async {
        for id in steering {
            let Some(ExecutionResolution::Owned { turn_id, .. }) = client
                .message_execution("queue-session", &id)
                .await
                .unwrap()
            else {
                panic!("steering was not canonically consumed");
            };
            assert_eq!(turn_id, root_turn.turn_id);
        }
        let mut turns = vec![root_turn.turn_id.clone()];
        for id in followups {
            let Some(ExecutionResolution::Owned { turn_id, .. }) = client
                .message_execution("queue-session", &id)
                .await
                .unwrap()
            else {
                panic!("follow-up was not canonically consumed");
            };
            assert!(!turns.contains(&turn_id));
            turns.push(turn_id);
        }
    });
    tui.close_terminal();
    tui.finish();
    client.disconnect();
    host.retire_registered();
    assert!(host.wait_for_exit().success());
}

async fn observe(client: &Client) -> SessionObservationSnapshot {
    let opened = client
        .open_subscription(SubscriptionOpenInput {
            session_id: "queue-session".into(),
            transcript: TranscriptPolicy::None,
        })
        .await
        .unwrap();
    client
        .close_subscription(&opened.subscription_id)
        .await
        .unwrap();
    opened.snapshot
}
async fn wait_queue(
    client: &Client,
    predicate: impl Fn(&SessionObservationSnapshot) -> bool,
) -> SessionObservationSnapshot {
    let mut last = None;
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let snapshot = observe(client).await;
            if predicate(&snapshot) {
                return snapshot;
            }
            last = Some(snapshot);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("canonical queue did not reach expected state: {last:?}"))
}
async fn provider(
    path: std::path::PathBuf,
) -> (
    String,
    oneshot::Sender<()>,
    oneshot::Sender<()>,
    tokio::task::JoinHandle<Vec<Value>>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let (release_first, first) = oneshot::channel();
    let (release_second, second) = oneshot::channel();
    let task = tokio::spawn(async move {
        let mut requests = vec![];
        let mut gates = [Some(first), Some(second)];
        for index in 0..4 {
            let (mut stream, body) = model_request(&listener).await;
            let wire = body.to_string();
            assert!(wire.contains("root task"));
            if index == 0 {
                assert!(
                    body["messages"].as_array().unwrap().iter().any(|message| {
                        message["role"] == "user" && message["content"] == ROOT_TASK
                    }),
                    "multiline draft must arrive intact: {body}"
                );
            }
            assert!(
                !wire.contains("remove-me")
                    && !wire.contains("follow-first-original")
                    && !wire.contains("unsent survives"),
                "{body}"
            );
            if index >= 1 {
                assert!(
                    wire.contains("promote-me") && wire.contains("direct-steering"),
                    "{body}"
                );
            }
            if index < 2 {
                assert!(
                    !wire.contains("follow-last") && !wire.contains("follow-first-edited"),
                    "{body}"
                );
            }
            if index == 2 {
                assert!(
                    wire.contains("follow-last") && !wire.contains("follow-first-edited"),
                    "{body}"
                );
            }
            if index == 3 {
                assert!(wire.contains("follow-first-edited"), "{body}");
            }
            requests.push(body);
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
            let text = [
                "Queue gate one",
                "Steering boundary reached",
                "Last followup completed",
                "Edited followup completed",
            ][index];
            stream
                .write_all(chunk(json!({"content":text}), None).as_bytes())
                .await
                .unwrap();
            if let Some(gate) = gates.get_mut(index).and_then(Option::take) {
                tokio::time::timeout(Duration::from_secs(30), gate)
                    .await
                    .unwrap()
                    .unwrap();
            }
            let (delta, reason) = if index == 0 {
                (
                    json!({"tool_calls":[{"index":0,"id":"read-queue","type":"function","function":{"name":"Read","arguments":json!({"path":path}).to_string()}}]}),
                    "tool_calls",
                )
            } else {
                (json!({}), "stop")
            };
            stream
                .write_all(chunk(delta, Some(reason)).as_bytes())
                .await
                .unwrap();
            stream.write_all(b"data: [DONE]\n\n").await.unwrap();
        }
        requests
    });
    (url, release_first, release_second, task)
}
fn chunk(delta: Value, reason: Option<&str>) -> String {
    format!(
        "data: {}\n\n",
        json!({
            "id":"queue-fixture","object":"chat.completion.chunk","model":"fixture-model",
            "choices":[{"index":0,"delta":delta,"finish_reason":reason}]
        })
    )
}

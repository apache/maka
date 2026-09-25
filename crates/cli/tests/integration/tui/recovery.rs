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
use maka_protocol::{Operation, message::SubmitInput, session::decode_session_create_input};
use serde_json::json;

#[test]
fn lost_submission_before_dispatch_and_after_acceptance_retries_without_duplicate_turns() {
    for after_acceptance in [false, true] {
        recover(after_acceptance);
    }
}

fn recover(after_acceptance: bool) {
    let directory = tempfile::tempdir().unwrap();
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
    runtime.block_on(async {
        use tokio::{net::TcpListener, io::AsyncWriteExt};
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let client = support::model_client(&host.root, &url).await;
        client.create_session(decode_session_create_input(&json!({
            "sessionId":"recovery", "name":"Recovery", "workspace":{"kind":"host_path","path":directory.path()}, "modelTarget":{"kind":"default"}
        })).unwrap()).await.unwrap();
        let model = tokio::spawn(async move {
            let (mut stream, _) = model_request(&listener).await;
            let frame = json!({"id":"recovery-fixture","object":"chat.completion.chunk","model":"fixture-model",
                "choices":[{"index":0,"delta":{"content":"Delivered once."},"finish_reason":"stop"}]});
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {frame}\n\ndata: [DONE]\n\n").as_bytes()).await.unwrap();
        });
        let proxy = LostReply::start(&host.root, directory.path(), after_acceptance).await;
        let mut tui = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
        tui.wait_for("Recovery");
        tui.click_text("Recovery");
        tui.wait_for("Message…");
        let checkpoint = directory.path().join("tui-state").join(&client.identity.root_id).join("default/state.json");
        if !after_acceptance {
            // Only this disposable profile: a directory cannot be replaced by the writer.
            if checkpoint.exists() { std::fs::remove_file(&checkpoint).unwrap(); }
            std::fs::create_dir(&checkpoint).unwrap();
        }
        tui.send("original 中文🦀\r".as_bytes());
        if !after_acceptance {
            tui.wait_for("Local changes not saved");
            assert!(proxy.requests.lock().unwrap().is_empty(), "failed persistence must prevent dispatch");
            tui.send(b"\x1b[200~ storage offline edit\x1b[201~");
            tui.wait_for("storage offline edit");
            std::fs::remove_dir(&checkpoint).unwrap();
            tui.filter_command("Retry original message");
            assert!(proxy.requests.lock().unwrap().is_empty(), "storage recovery must not automatically resend");
            tui.click_text("Retry original message");
        }
        tui.wait_for("Delivery uncertain");
        tui.wait_for("connection failed"); // The request failure can precede the connection-close observation.
        tui.click_last_text("original 中文🦀");
        tui.send(b"\x1b[200~ plus new edits\x1b[201~");
        tui.wait_for("plus new edits");
        if after_acceptance {
            tui.close_terminal();
            tui.finish();
        } else {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let saved: serde_json::Value = serde_json::from_slice(&std::fs::read(&checkpoint).unwrap()).unwrap();
                if saved["drafts"]["recovery"]["text"].as_str().is_some_and(|text| text.contains("plus new edits")) { break; }
                assert!(Instant::now() < deadline, "draft autosave timed out");
                tui.read();
            }
            // SIGKILL cannot run the normal quit flush; only the prior checkpoint survives.
            assert!(!tui.terminate().unwrap().success());
        }
        let mut tui = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
        tui.wait_for(if after_acceptance { "Delivered once." } else { "No messages yet." });
        tui.wait_for("plus new edits");
        tui.wait_for("Delivery uncertain");
        assert_eq!(proxy.requests.lock().unwrap().len(), 1, "reopening must not automatically replay");
        tui.filter_command("Retry original message");
        // wait_for already waits for a complete synchronized frame. An unrelated
        // last command may be below the viewport when a live turn adds actions.
        tui.click_text("Retry original message");
        // Closing the palette can temporarily cover/erase the old feedback before
        // the checkpoint releases the explicit retry. Observe the real relay too.
        tui.wait_until(|screen| proxy.requests.lock().unwrap().len() == 2 && !screen.contains("Delivery uncertain") && !screen.contains("Sending…") && screen.contains("plus new edits"));
        let requests = proxy.requests.lock().unwrap().clone();
        assert_eq!(requests.len(), 2, "reconnect must not automatically replay");
        assert_eq!(requests[0], requests[1], "retry must not send the new draft or rebind the original identity");
        let input: SubmitInput = serde_json::from_value(requests[0].clone()).unwrap();
        assert_eq!(input.origin_host_epoch, client.identity.host_epoch);
        assert_eq!(input.content.text, "original 中文🦀");
        tui.close_terminal();
        tui.finish();
        drop(proxy);
        let first = client.submit_message(input.clone()).await.unwrap();
        let maka_protocol::message::SubmitResult::TurnStarted { turn_id, .. } = &first else { panic!("expected real turn") };
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let turn = client.request(Operation::TurnQuery, json!({"sessionId":"recovery","turnId":turn_id})).await.unwrap();
                match turn["status"].as_str() {
                    Some("completed") => break,
                    Some("failed" | "cancelled") => panic!("fixture turn failed: {turn}"),
                    _ => tokio::time::sleep(Duration::from_millis(20)).await,
                }
            }
        }).await.unwrap();
        model.await.unwrap();
        // The retry must return the original durable result, not start another model request.
        assert_eq!(client.submit_message(input.clone()).await.unwrap(), first);
        let mut altered = input.clone();
        altered.content.text.push_str(" edited");
        assert!(matches!(client.submit_message(altered).await,
            Err(maka_client::RequestFailure::Rejected(maka_client::ClientError::Rejected(error)))
            if error.code == maka_protocol::OperationErrorCode::OperationConflict));
        let mut stale = input.clone();
        stale.origin_host_epoch = "previous-epoch".into();
        // A known canonical identity is provable even with its old envelope.
        assert_eq!(client.submit_message(stale.clone()).await.unwrap(), first);
        stale.message_id = "never-admitted".into();
        assert!(matches!(client.submit_message(stale).await,
            Err(maka_client::RequestFailure::Rejected(maka_client::ClientError::Rejected(error)))
            if error.code == maka_protocol::OperationErrorCode::OutcomeUnknown));
        assert!(matches!(client.message_execution("recovery", "never-admitted").await.unwrap(),
            Some(maka_protocol::message::ExecutionResolution::NotAdmitted { message_id }) if message_id == "never-admitted"));
        let opened = client.open_subscription(maka_protocol::subscription::SubscriptionOpenInput {
            session_id:"recovery".into(), transcript:maka_protocol::subscription::TranscriptPolicy::Tail {max_bytes:16_384}
        }).await.unwrap();
        let batch = client.complete_transcript_page(&opened.subscription_id, opened.transcript.unwrap().durable).await.unwrap();
        assert_eq!(batch.rows.iter().filter(|row| row.value["type"] == "user").count(), 1);
        assert_eq!(opened.snapshot.root_turn.unwrap().turn_id, *turn_id);
        client.close_subscription(&opened.subscription_id).await.unwrap();
        client.disconnect();
    });
    host.retire_registered();
    assert!(host.wait_for_exit().success());
}

/// Only this disposable Root's registration points at the relay. The real Host
/// performs every operation; the relay loses the first submit before dispatch
/// or its accepted reply. Both cases disconnect, with no fabricated Host frames.
/// OAuth recovery reuses this relay but never forwards a start to a provider;
/// it checks the on-disk identity before dropping that request.
pub(super) struct LostReply {
    registration: std::path::PathBuf,
    original: Vec<u8>,
    task: tokio::task::JoinHandle<()>,
    requests: std::sync::Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
}

impl LostReply {
    async fn start(
        root: &std::path::Path,
        directory: &std::path::Path,
        after_acceptance: bool,
    ) -> Self {
        Self::start_operation(root, directory, after_acceptance, "turn.message.submit").await
    }

    pub(super) async fn oauth_start(root: &std::path::Path, directory: &std::path::Path) -> Self {
        Self::start_operation(root, directory, false, "oauth.login.start").await
    }
    pub(super) async fn terminal_submit(
        root: &std::path::Path,
        directory: &std::path::Path,
        after_acceptance: bool,
    ) -> Self {
        Self::start_operation(root, directory, after_acceptance, "plugin.remote").await
    }

    pub(super) fn requests(&self) -> Vec<serde_json::Value> {
        self.requests.lock().unwrap().clone()
    }

    async fn start_operation(
        root: &std::path::Path,
        directory: &std::path::Path,
        after_acceptance: bool,
        operation: &'static str,
    ) -> Self {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let discovery = maka_client::local::read_discovery(root).unwrap();
        let registration = maka_event_log::root::RootNamespaces::for_current_account()
            .unwrap()
            .control
            .join(&discovery.root_id)
            .join("registration.json");
        let original = std::fs::read(&registration).unwrap();
        let socket = directory.join("lost-reply.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = requests.clone();
        let checkpoint = directory
            .join("tui-state")
            .join(&discovery.root_id)
            .join("default/state.json");
        let task = tokio::spawn(async move {
            let mut lose = true;
            // The TUI reconnects only after this connection is dropped.
            while let Ok((stream, _)) = listener.accept().await {
                let host = tokio::net::UnixStream::connect(&discovery.endpoint)
                    .await
                    .unwrap();
                let (read_client, mut write_client) = stream.into_split();
                let (read_host, mut write_host) = host.into_split();
                let mut from_client = BufReader::new(read_client).lines();
                let mut from_host = BufReader::new(read_host).lines();
                let mut submission_id = None;
                loop {
                    tokio::select! {
                        line = from_client.next_line() => {
                            let Ok(Some(line)) = line else { break };
                            let value: serde_json::Value = serde_json::from_str(&line).unwrap();
                            if value["operation"] == operation && (operation != "plugin.remote" || value["input"]["kind"] == "call" && value["input"]["input"]["kind"] == "submit") {
                                submission_id = value.get("requestId").cloned();
                                let saved: serde_json::Value = serde_json::from_slice(&std::fs::read(&checkpoint).unwrap()).unwrap();
                                if operation == "oauth.login.start" {
                                    assert_eq!(saved["root"], discovery.root_id);
                                    assert_eq!(saved["oauth"]["attempt"], json!({
                                        "attemptId":value["input"]["attemptId"],
                                        "target":value["input"]["target"]
                                    }));
                                    captured.lock().unwrap().push(value["input"].clone());
                                    // Never forward an OAuth start to a real provider. Only
                                    // enrollment/query/cancel exercise the actual Host here.
                                    break;
                                }
                                if operation == "plugin.remote" {
                                    assert_eq!(saved["root"], discovery.root_id);
                                    assert_eq!(saved["apps"][0]["pending"]["input"], value["input"]["input"]);
                                    assert_eq!(saved["apps"][0]["entry"]["target"], value["input"]["target"]);
                                } else {
                                    let original = &saved["unresolved"][0];
                                    assert_eq!(original["root_id"], discovery.root_id);
                                    assert_eq!(original["origin_epoch"], value["input"]["originHostEpoch"]);
                                    assert_eq!(original["session"], value["input"]["sessionId"]);
                                    assert_eq!(original["id"], value["input"]["messageId"]);
                                    assert_eq!(saved["version"], 22);
                                    assert_eq!(original["content"], value["input"]["content"]);
                                    assert_eq!(original["placement"], value["input"]["placement"]);
                                    assert_eq!(original["input_selections"], value["input"].get("inputSelections").cloned().unwrap_or_else(|| json!({})));
                                    assert_eq!(original["turn_orchestration"], value["input"]["turnOrchestration"]);
                                }
                                captured.lock().unwrap().push(value["input"].clone());
                                if lose && !after_acceptance {
                                    lose = false;
                                    break;
                                }
                            }
                            if write_host.write_all((line + "\n").as_bytes()).await.is_err() { break; }
                        }
                        line = from_host.next_line() => {
                            let Ok(Some(line)) = line else { break };
                            let value: serde_json::Value = serde_json::from_str(&line).unwrap();
                            if lose && value["operation"] == operation && value["ok"] == true && value.get("requestId") == submission_id.as_ref() {
                                lose = false;
                                break;
                            }
                            if write_client.write_all((line + "\n").as_bytes()).await.is_err() { break; }
                        }
                    }
                }
            }
        });
        let proxy = Self {
            registration,
            original,
            task,
            requests,
        };
        let mut record: serde_json::Value = serde_json::from_slice(&proxy.original).unwrap();
        record["endpoint"] = json!(socket);
        std::fs::write(&proxy.registration, serde_json::to_vec(&record).unwrap()).unwrap();
        proxy
    }
}

impl Drop for LostReply {
    fn drop(&mut self) {
        self.task.abort();
        std::fs::write(&self.registration, &self.original)
            .expect("restore isolated Host discovery");
    }
}

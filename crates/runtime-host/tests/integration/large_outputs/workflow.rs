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

use super::super::support::attachment_client::{self as support, NativeHost};
use maka_client::{Client, Notification};
use maka_protocol::{
    Operation, OperationErrorCode as Code,
    subscription::{SubscriptionOpenInput, TranscriptPolicy},
    transcript::{SessionTranscriptPageDirection, SessionTranscriptPageInput},
};
use maka_runtime::artifact::{content_digest, upload_artifact_id};
use serde_json::{Value, json};
use std::{path::Path, time::Duration};

const SIZE: usize = 10 * 1024 * 1024;
pub(super) struct Saved {
    turn: Value,
    terminal: Value,
    digest: String,
    row_id: Option<Value>,
}
pub(super) async fn model() -> support::Model {
    support::Model::start(8, |index, input| {
        let case = if [0, 1, 4, 6].contains(&index) {
            "ascii"
        } else {
            "control"
        };
        assert_eq!(input["model"], format!("{case}-model"));
        let tools: Vec<_> = input["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["role"] == "tool")
            .collect();
        if index == 0 || index == 2 {
            assert!(tools.is_empty());
            support::read(
                "read-large",
                &upload_artifact_id(&format!("large-output-{case}"), "large-text"),
            )
        } else {
            assert_eq!(tools.len(), 1);
            assert_eq!(tools[0]["tool_call_id"], "read-large");
            let content = tools[0]["content"].as_str().unwrap();
            assert!(content.encode_utf16().count() <= 7500);
            let page: Value = serde_json::from_str(content).unwrap();
            assert!(!page["content"].as_str().unwrap().is_empty());
            assert_eq!(page["partialLine"], true);
            assert_eq!(page["returnedLines"], 0);
            assert_eq!(page["totalLines"], 1);
            assert!(
                page["next"]["path"]
                    .as_str()
                    .unwrap()
                    .starts_with("maka://read/")
            );
            json!({"content":"large output complete"})
        }
    })
    .await
}
pub(super) async fn verify(
    native: &mut NativeHost,
    workspace: &Path,
    url: &str,
    reopened: bool,
    saved: &mut Vec<Saved>,
) {
    let client = &native.client;
    let mut live = None;
    if !reopened {
        let connection = support::configure(
            client,
            url,
            json!({
                "ascii-model":{"vision":false},"control-model":{"vision":false}
            }),
        )
        .await;
        for (case, byte) in [("ascii", 65), ("control", 1)] {
            let session = format!("large-output-{case}");
            support::session(
                client,
                &connection,
                workspace,
                &session,
                &format!("{case}-model"),
            )
            .await;
            let bytes = vec![byte; SIZE];
            let attachment = support::upload(
                client,
                &session,
                "large-text",
                &format!("{case}.txt"),
                "text/plain",
                &bytes,
            )
            .await;
            let turn = json!({"sessionId":session,"turnId":"read-large","maxSteps":3,
                "content":{"text":"Read the uploaded text","attachments":[attachment]}});
            if case == "control" {
                let open = client
                    .open_subscription(SubscriptionOpenInput {
                        session_id: session.clone(),
                        transcript: TranscriptPolicy::Tail { max_bytes: 2 },
                    })
                    .await
                    .unwrap();
                client
                    .ready_subscription(&open.subscription_id)
                    .await
                    .unwrap();
                live = Some(open.subscription_id);
            }
            // This is an active subscriber. Drain live frames while polling the
            // Turn so the bounded client queue does not fail as a slow consumer.
            let terminal = {
                let completed = support::completed(client, &turn);
                tokio::pin!(completed);
                loop {
                    tokio::select! {
                        result = &mut completed => break result,
                        notice = native.notices.recv() => assert!(notice.is_some(), "client disconnected during the Turn"),
                    }
                }
            };
            if case == "control" {
                capacity(client, &session, live.as_deref()).await;
                let basis = client
                    .request(
                        Operation::SessionCatalogQuery,
                        json!({"kind":"get","sessionId":session}),
                    )
                    .await
                    .unwrap();
                let changed = client.request(Operation::SessionMetadataUpdate,json!({
                    "sessionId":session,"expectedRevision":basis["session"]["revision"],"patch":{"name":"Capacity remains observable"}
                })).await.unwrap();
                assert_eq!(changed["kind"], "committed");
                tokio::time::timeout(Duration::from_secs(5), async {
                    loop {
                        let notice = native.notices.recv().await.unwrap();
                        if let Notification::Observation(frame) = notice
                            && let maka_protocol::subscription::ObservationFrame::Projection(frame) = *frame
                        {
                            let maka_protocol::subscription::SessionProjectionFrame::SessionProjection {
                                subscription_id, snapshot, ..
                            } = *frame;
                            if Some(subscription_id.as_str()) == live.as_deref()
                                && Some(snapshot.session.metadata_revision) == changed["session"]["revision"].as_u64() {
                                break;
                            }
                        }
                    }
                })
                .await
                .unwrap();
            }
            saved.push(Saved {
                turn,
                terminal,
                digest: content_digest(&bytes),
                row_id: None,
            });
        }
    }
    for item in saved {
        let session = item.turn["sessionId"].as_str().unwrap();
        assert_eq!(
            client
                .request(
                    Operation::TurnQuery,
                    json!({"sessionId":session,"turnId":"read-large"})
                )
                .await
                .unwrap(),
            item.terminal
        );
        assert_eq!(
            client
                .request(Operation::TurnStart, item.turn.clone())
                .await
                .unwrap()["turn"],
            item.terminal
        );
        if session.ends_with("ascii") {
            let rows = support::rows(client, session).await;
            let results: Vec<_> = rows.iter().filter(|r| r["type"] == "tool_result").collect();
            assert_eq!(results.len(), 1, "no replayed effect");
            let row = results[0];
            assert_eq!(row["isError"], false);
            assert_eq!(row["content"]["kind"], "text");
            let text = row["content"]["text"].as_str().unwrap();
            assert_eq!(text.len(), SIZE);
            assert_eq!(content_digest(text.as_bytes()), item.digest);
            if let Some(id) = &item.row_id {
                assert_eq!(id, &row["id"]);
            } else {
                item.row_id = Some(row["id"].clone());
            }
        } else {
            capacity(client, session, live.as_deref()).await;
        }
        support::completed(
            client,
            &json!({"sessionId":session,
                "turnId":if reopened {"after-reopen"} else {"after-capacity"},
                "content":{"text":"Confirm completion"},"maxSteps":1
            }),
        )
        .await;
        if session.ends_with("control") {
            capacity(client, session, live.as_deref()).await;
        }
        assert_eq!(
            client
                .request(Operation::HostStatus, json!({}))
                .await
                .unwrap()["state"],
            "ready"
        );
    }
    if let Some(id) = live {
        client.close_subscription(&id).await.unwrap();
    }
}
async fn capacity(client: &Client, session: &str, live: Option<&str>) {
    if let Some(id) = live {
        support::rejected(
            client
                .transcript_page(SessionTranscriptPageInput {
                    subscription_id: id.into(),
                    direction: SessionTranscriptPageDirection::Older,
                    through_sequence: None,
                    cursor: None,
                    anchor_sequence: None,
                    max_bytes: 48 * 1024,
                })
                .await,
            Code::OperationUnavailable,
        );
    }
    support::rejected(
        client
            .open_subscription(SubscriptionOpenInput {
                session_id: session.into(),
                transcript: TranscriptPolicy::Tail { max_bytes: 2 },
            })
            .await,
        Code::OperationUnavailable,
    );
    assert_eq!(
        client
            .request(Operation::HostStatus, json!({}))
            .await
            .unwrap()["state"],
        "ready"
    );
}

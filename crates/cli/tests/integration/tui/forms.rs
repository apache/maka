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
use maka_runtime::event::{Fact, RuntimeEvent};
use serde_json::{Value, json};
use sqlx::{
    Connection,
    sqlite::{SqliteConnectOptions, SqliteConnection},
};

mod fixture;

#[test]
fn real_host_code_mode_form_waits_without_model_progress_and_submits_from_tui() {
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
    let fixture = runtime.block_on(fixture::start(&host.root, directory.path()));
    let mut reader = runtime
        .block_on(SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(host.root.join(maka_event_log::root::ROOT_DATABASE))
                .read_only(true),
        ))
        .unwrap();
    let mut tui = Pty::spawn_at(
        &["--root", host.root.to_str().unwrap()],
        Some(directory.path()),
    );
    tui.wait_for("Form keyboard fixture");
    tui.click_text("Form keyboard fixture");
    tui.wait_for("Message…");
    tui.send(b"Collect a form\r");
    tui.click_text("Settings");
    tui.wait_for("Maka dark ▾");
    // Global discovery while this session has no transcript subscription.
    tui.wait_for("◇ Form keyboard fixture");
    assert!(
        !tui.screen
            .snapshot()
            .unwrap()
            .screen
            .contains("Fill the isolated form")
    );
    // A background request must not steal the Settings focus: Interface
    // category, Icons row, its chooser, then ASCII.
    tui.send(b"\x1b[B");
    tui.wait_for("Unicode ▾");
    tui.send(b"\x1b[C\x1b[B\r");
    tui.wait_for("○ ASCII");
    tui.send(b"\x1b[B\r");
    tui.wait_for("ASCII v");
    tui.send(b"\r\x1b[A\r");
    tui.wait_for("Unicode ▾");
    // The waiting session is marked in the sidebar; opening it is not an answer.
    tui.click_text("Form keyboard fixture");
    tui.wait_until(|screen| !screen.contains("Maka dark ▾") && screen.contains("Message…"));
    tui.wait_for("!");
    tui.click_text("!");
    tui.wait_for("Fill the isolated form");
    // Observe the actual exec settlement, not just the configured yield duration.
    runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let events: Vec<RuntimeEvent> = sqlx::query_scalar::<_, String>(
                    "SELECT event_json FROM runtime_events ORDER BY sequence"
                ).fetch_all(&mut reader).await.unwrap().into_iter()
                    .map(|row| serde_json::from_str(&row).unwrap()).collect();
                let exec = events.iter().find_map(|event| match &event.fact {
                    Fact::ToolDispatched { operation_id, name, call, .. } if name == "exec" && call.tool_call_id == "call-2" => Some(operation_id),
                    _ => None,
                });
                if events.iter().any(|event| matches!(&event.fact, Fact::ToolSettled { operation_id, .. } if Some(operation_id) == exec)) { break; }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.unwrap();
    });
    // Cross the observation boundary with no user answer, including closing the
    // overlay. The HTTP server records requests before any fixture-side wait.
    tui.send(b"\x1b");
    tui.wait_until(|screen| !screen.contains("Fill the isolated form"));
    std::thread::sleep(Duration::from_millis(250));
    assert_eq!(
        fixture.requests.load(std::sync::atomic::Ordering::SeqCst),
        2,
        "an unanswered form must prevent a new model request after exec yielded"
    );
    let pending: i64 = runtime.block_on(sqlx::query_scalar("SELECT COUNT(*) FROM interaction_requests r LEFT JOIN interaction_outcomes o USING(request_id) WHERE o.request_id IS NULL").fetch_one(&mut reader)).unwrap();
    assert_eq!(pending, 1);
    tui.click_text("!");
    tui.wait_for("Fill the isolated form");
    tui.wait_for("Display name");
    tui.click_text("Enter a value…");
    tui.send("\x1b[200~中文🦀\x1b[201~".as_bytes());
    tui.wait_for("中文🦀");
    tui.resize(80, 24);
    // The value also exists in the old frame; wait for the narrow layout before clicking.
    tui.wait_until(|screen| screen.contains("中文🦀") && !screen.contains("+  New session"));
    tui.click_text("Submit form");
    tui.wait_for("Decision recorded by Host.");
    tui.send(b"\x1b");
    tui.wait_for("Form received exactly once");
    tui.command("Open pending requests");
    tui.wait_for("Nothing waiting");
    tui.send(b"\x02"); // Close the sidebar; filtering never left the conversation.
    tui.wait_for("Form received exactly once");
    let result = runtime.block_on(fixture.provider).unwrap();
    runtime.block_on(fixture.model).unwrap();
    assert_eq!(
        result,
        json!({"action":"accept","values":{"name":"中文🦀","count":2.0,"enabled":false}})
    );
    let outcomes: Vec<String> = runtime
        .block_on(
            sqlx::query_scalar("SELECT outcome_json FROM interaction_outcomes")
                .fetch_all(&mut reader),
        )
        .unwrap();
    assert_eq!(outcomes.len(), 1);
    let outcome: Value = serde_json::from_str(&outcomes[0]).unwrap();
    assert_eq!(
        maka_protocol::capability::decode_form_result(&json!({
            "action":"accept", "values":outcome["values"]
        }))
        .unwrap(),
        maka_protocol::capability::decode_form_result(&result).unwrap()
    );
    tui.wait_for("➤");
    let settled = runtime
        .block_on(fixture.client.open_subscription(
            maka_protocol::subscription::SubscriptionOpenInput {
                session_id: "tui-form".into(),
                transcript: maka_protocol::subscription::TranscriptPolicy::None,
            },
        ))
        .unwrap();
    assert!(matches!(
        settled.snapshot.root_turn.unwrap().state,
        maka_protocol::turn::TurnState::Completed { .. }
    ));
    runtime
        .block_on(fixture.client.close_subscription(&settled.subscription_id))
        .unwrap();
    fixture.client.disconnect();
    tui.close_terminal();
    tui.finish();
    runtime.block_on(reader.close()).unwrap();
    host.retire_registered();
    assert!(host.wait_for_exit().success());
}

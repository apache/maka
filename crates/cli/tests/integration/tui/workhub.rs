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
use maka_protocol::{
    Operation,
    plugin::{RemoteBinding, RemoteRequest, RemoteResult},
};
use serde_json::{Value, json};

mod composition;
mod manual;
mod model;
mod readback;
mod setup;

/// The installed binary and its native WorkHub know nothing about the later
/// JavaScript filler. Every normal mutation below starts at a real PTY control.
#[test]
fn new_root_delegates_repairs_the_same_task_and_composes_a_runtime_js_filler() {
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
    let frozen = readback::binary_digest();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let (client, provider) = runtime.block_on(async {
        (
            support::client(&host.root).await,
            model::Provider::start().await,
        )
    });
    let mut tui = Pty::spawn_at(
        &["--root", host.root.to_str().unwrap()],
        Some(directory.path()),
    );
    tui.resize(170, 48);
    setup::connection(&mut tui, &runtime, &client, &provider.url);
    setup::hub(&mut tui, &runtime, &client, directory.path());
    let coordinator =
        runtime.block_on(readback::hub(&client, "query", Value::Null))["coordinatorSessionId"]
            .as_str()
            .unwrap()
            .to_owned();
    setup::delegate(&mut tui, "alpha");
    let alpha = runtime.block_on(readback::assignment(&client, "Task alpha", true));
    assert_eq!(readback::source_session(&alpha), coordinator);
    let alpha_session = readback::session(&alpha);
    assert_ne!(alpha_session, coordinator);
    setup::open_task(&mut tui, "Task alpha");
    tui.wait_for("Result alpha complete");
    tui.click_page_text("Open the session doing it");
    tui.wait_for("Message…");
    tui.click_text("ⓘ");
    tui.wait_for(&format!("Session ID: {alpha_session}"));
    setup::open_task(&mut tui, "Task alpha");

    runtime.block_on(composition::install(&client, directory.path()));
    assert_eq!(
        frozen,
        readback::binary_digest(),
        "runtime installation must use the frozen binary"
    );
    tui.wait_for("Note draft");
    let alpha_id = alpha["operationId"].as_str().unwrap();
    runtime.block_on(composition::context(&client, alpha_id, &coordinator));
    // Keyboard crosses the native parent / JS child boundary. Shift+Tab from
    // the first input returns to the parent's final model link; Tab comes back.
    tui.click_page_text("Note draft");
    tui.send(b"\x1b[Z\r");
    tui.wait_for("Find a model or executor");
    tui.click_last_text("‹ WorkHub");
    tui.wait_for("Note draft");
    tui.click_page_text("Note draft");
    tui.send(b"\x1b[Z\t");
    tui.send(b"\x1b[200~alpha private draft\x1b[201~");
    tui.wait_for("alpha private draft");

    // Remove only the selected task model. The coordinator remains available.
    runtime.block_on(readback::remove_worker_model(&client));
    tui.click_last_text("‹ WorkHub");
    tui.wait_for("Coordinator conversation");
    setup::delegate(&mut tui, "beta");
    let beta = runtime.block_on(readback::assignment(&client, "Task beta", false));
    assert!(
        beta["delivery"].is_null(),
        "unavailable model must not admit a task"
    );
    let beta_id = beta["operationId"].as_str().unwrap();
    let original = runtime.block_on(readback::frozen_request(&host.root, beta_id));
    assert_eq!(
        original["target"]["request"]["settings"]["target"]["model"]["model"],
        "worker-model"
    );
    setup::open_task(&mut tui, "Task beta");
    tui.wait_for("Note draft");
    assert!(
        !tui.screen
            .snapshot()
            .unwrap()
            .screen
            .contains("alpha private draft")
    );
    runtime.block_on(composition::context(&client, beta_id, &coordinator));
    runtime.block_on(composition::notify(&client, beta_id));
    tui.wait_for("Reviewed independently");
    tui.click_page_text("Note draft");
    tui.send(b"\x1b[200~beta private draft\x1b[201~");
    tui.wait_for("beta private draft");
    tui.click_page_text("Change task model");
    tui.wait_for("Find a model or executor");
    tui.click_page_text("fixture-model");
    tui.wait_for("The same delegated task keeps its original dispatch identity.");
    tui.click_page_text("Use this configuration");
    tui.wait_for("Coordinator conversation");
    let repaired = runtime.block_on(readback::assignment(&client, "Task beta", true));
    assert_eq!(repaired["operationId"], beta["operationId"]);
    assert_eq!(repaired["source"], beta["source"]);
    assert_eq!(
        original,
        runtime.block_on(readback::frozen_request(&host.root, beta_id)),
        "model repair must preserve the original assignment and root operation"
    );
    let beta_session = readback::session(&repaired);
    assert_ne!(alpha_session, beta_session);
    setup::open_task(&mut tui, "Task beta");
    tui.wait_for("Result beta complete");
    tui.wait_for("beta private draft");
    assert!(
        !tui.screen
            .snapshot()
            .unwrap()
            .screen
            .contains("alpha private draft")
    );
    tui.click_page_text("Save note");
    tui.wait_until(|s| s.contains("Saved note: beta private draft"));
    tui.click_last_text("‹ WorkHub");
    setup::select_task(&mut tui, "Task alpha");
    tui.wait_for("alpha private draft");
    assert!(
        !tui.screen
            .snapshot()
            .unwrap()
            .screen
            .contains("beta private draft")
    );
    tui.click_page_text("Save note");
    tui.wait_for("Saved note: alpha private draft");
    runtime.block_on(composition::saved(&client, alpha_id, beta_id));

    // Keep composition open in a narrow ASCII terminal, then retire the filler.
    setup::ascii(&mut tui);
    tui.resize(80, 32);
    tui.wait_for("Saved note: alpha private draft");
    runtime.block_on(composition::disable(&client, alpha_id, &coordinator));
    tui.wait_until(|s| !s.contains("Save note") && s.contains("Open the session doing it"));
    tui.click_page_text("Open the session doing it");
    tui.wait_for("Message…");
    tui.close_terminal();
    tui.finish();

    // Language coverage uses the existing tasks and readback, not another
    // identical end-to-end setup for each locale and terminal width.
    setup::localized(&host.root, "zh-CN", "协调对话", "新任务设置");
    setup::localized(&host.root, "zh-TW", "協調對話", "新任務設定");
    runtime.block_on(async {
        let page = readback::hub(&client, "assignments", json!({"after":null})).await;
        assert_eq!(page["entries"].as_array().unwrap().len(), 2);
        let sessions = client
            .session_catalog(maka_protocol::session::SessionCatalogQueryInput::ListStart)
            .await
            .unwrap();
        let maka_protocol::session::SessionCatalogQueryResult::Page { sessions, .. } = sessions
        else {
            panic!("sessions")
        };
        assert_eq!(sessions.len(), 3, "coordinator plus one session per task");
        assert_eq!(
            provider.executed.lock().unwrap().as_slice(),
            ["alpha", "beta"]
        );
        assert_eq!(
            provider.delegated.lock().unwrap().len(),
            2,
            "repair must not ask the model to redispatch"
        );
    });
    provider.task.abort();
    client.disconnect();
    host.retire_registered();
    assert!(host.wait_for_exit().success());
}

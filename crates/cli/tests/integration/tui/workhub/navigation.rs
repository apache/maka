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

const PACKAGE: &str = "example.nested-navigation";

#[test]
fn rust_parent_and_installed_js_child_restore_exact_routes_and_independent_drafts() {
    let directory = tempfile::tempdir().unwrap();
    let mut host =
        super::super::super::candidate::CandidateFixture::new(directory.path().join("root"));
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
    setup::delegate(&mut tui, "alpha");
    let assignment = runtime.block_on(readback::assignment(&client, "Task alpha", true));
    let origin = json!({
        "assignmentId": assignment["operationId"],
        "sourceSessionId": readback::source_session(&assignment)
    });
    setup::open_task(&mut tui, "Task alpha");
    let package = directory.path().join("nested-navigation-plugin");
    std::fs::create_dir(&package).unwrap();
    std::fs::write(
        package.join("host.mjs"),
        include_str!("../../../fixtures/nested-navigation-plugin/host.mjs"),
    )
    .unwrap();
    std::fs::write(
        package.join("nested-ui.mjs"),
        include_str!("../../../fixtures/nested-navigation-plugin/nested-ui.mjs"),
    )
    .unwrap();
    std::fs::write(
        package.join("maka.extension.json"),
        json!({
            "schemaVersion": 1, "id": PACKAGE, "runtime": {"entry": "host.mjs", "sdkVersion": 2}
        })
        .to_string(),
    )
    .unwrap();
    runtime.block_on(async {
        client.request(Operation::PluginPackageInstall, json!({"sourcePath": package})).await.unwrap();
        client.request(Operation::PluginCompositionApply, json!({"operations": [{
            "type": "insert", "rootId": "profile", "entry": {"id": "nested-navigation", "packageId": PACKAGE}
        }]})).await.unwrap();
    });
    tui.wait_for("Base note draft");
    tui.click_page_text("Base note draft");
    tui.send(b"\x1b[200~base private draft\x1b[201~");
    tui.wait_for("base private draft");
    tui.click_page_text("Note details");
    tui.wait_for("Detail note draft");
    tui.click_page_text("Detail note draft");
    tui.send(b"\x1b[200~detail private draft\x1b[201~");
    tui.wait_for("detail private draft");
    tui.close_terminal();
    tui.finish();

    let checkpoint = directory
        .path()
        .join("tui-state")
        .join(&client.identity.root_id)
        .join("default/state.json");
    let saved: Value = serde_json::from_slice(&std::fs::read(&checkpoint).unwrap()).unwrap();
    let drafts: Vec<_> = saved["apps"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["key"]["package"] == PACKAGE)
        .collect();
    assert_eq!(drafts.len(), 2);
    for text in ["base private draft", "detail private draft"] {
        let draft = drafts
            .iter()
            .find(|item| item["drafts"]["note"] == text)
            .unwrap();
        assert_eq!(draft["key"]["origin"], origin);
        assert_eq!(draft["key"]["within"][0]["package"], "maka.workhub");
        assert_eq!(
            draft["key"]["within"][0]["route"]["assignment"],
            assignment["operationId"]
        );
    }
    let details = json!({"context": origin, "pane": "details"});
    let location =
        &saved["navigation"]["entries"][saved["navigation"]["cursor"].as_u64().unwrap() as usize];
    assert_eq!(location["embedded"][0]["route"], details);
    assert_eq!(
        runtime.block_on(readback::remote(&client, PACKAGE, "writes", Value::Null)),
        0
    );

    let mut tui = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
    tui.resize(170, 48);
    tui.wait_for("detail private draft");
    tui.wait_for("Resume draft");
    tui.click_page_text("Resume draft");
    tui.wait_for("Draft ready");
    assert_eq!(
        runtime.block_on(readback::remote(&client, PACKAGE, "writes", Value::Null)),
        0
    );
    tui.send(b"\x1b[1;3D");
    tui.wait_for("base private draft");
    tui.wait_for("Resume draft");
    tui.click_page_text("Resume draft");
    tui.wait_for("Draft ready");
    tui.send(b"\x1b[1;3C");
    tui.wait_for("detail private draft");
    tui.click_page_text("Save nested note");
    tui.wait_for("Stored: detail private draft");
    tui.close_terminal();
    tui.finish();

    // The selected child is now clean. Its navigated route still survives.
    let mut tui = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
    tui.resize(170, 48);
    tui.wait_for("Detail note draft");
    tui.wait_for("Stored: detail private draft");
    tui.send(b"\x1b[1;3D");
    tui.wait_for("base private draft");
    tui.close_terminal();
    tui.finish();
    assert_eq!(
        runtime.block_on(readback::remote(&client, PACKAGE, "writes", Value::Null)),
        1
    );
    assert_eq!(provider.executed.lock().unwrap().as_slice(), ["alpha"]);
    assert_eq!(provider.delegated.lock().unwrap().len(), 1);
    provider.task.abort();
    client.disconnect();
    host.retire_registered();
    assert!(host.wait_for_exit().success());
}

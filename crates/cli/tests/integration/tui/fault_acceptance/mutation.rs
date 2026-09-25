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

use super::{CandidateFixture, Operation, Pty, Runtime, Value, fixture, json};
use std::{path::Path, time::Duration};

mod applied;

const PACKAGE: &str = "example.mutation-fault";

#[test]
fn committed_javascript_submit_survives_vm_death_and_reopens_with_original_recovery() {
    let directory = tempfile::tempdir().unwrap();
    let mut host = CandidateFixture::new(directory.path().join("root"));
    fixture::serve(&mut host);
    let runtime = Runtime::new().unwrap();
    let operation = uuid::Uuid::new_v4().to_string();
    let (client, notices) = runtime.block_on(fixture::connect(&host.root));
    runtime.block_on(install(&client, directory.path(), &operation));
    let mut tui = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
    tui.wait_for("Mutation fault");
    tui.click_text("Mutation fault");
    tui.wait_for("Original note");
    tui.click_text("Original note");
    tui.send(b"\x1b[200~Exact original payload\x1b[201~");
    tui.click_text("Commit then fail");
    let committed = runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                if let Some(value) = record(&host.root, &format!("operations/{operation}")).await {
                    break value;
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .expect("real JS mutation and receipt must commit before VM death")
    });
    assert_eq!(committed["operation"], operation);
    assert_eq!(
        committed["submission"]["fields"]["note"],
        "Exact original payload"
    );
    assert_eq!(committed["submissions"], 1);
    assert_eq!(
        runtime.block_on(record(&host.root, "business")).unwrap()["count"],
        1
    );
    tui.wait_for("result is unconfirmed");
    tui.wait_for("Check original submission");
    // A normal close flushes the post-failure state. Crashing immediately after
    // dispatch could accidentally pass using an obsolete pre-dispatch checkpoint.
    tui.close_terminal();
    tui.finish();
    let saved = checkpoint(directory.path(), &host.root_id);
    let original = saved["apps"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["pending"]["input"]["revision"] == operation)
        .expect("the completed failure must preserve its original frozen proof");
    assert_eq!(
        original["pending"]["recovery"],
        json!({"operation":operation})
    );
    assert_eq!(original["pending"]["input"]["action"], "runaway");
    assert_eq!(
        original["pending"]["input"]["fields"],
        committed["submission"]["fields"]
    );
    assert_eq!(original["pending"]["withheld"], false);
    assert!(!original["entry"]["target"]["registration"].is_null());
    client.disconnect();
    runtime.block_on(async {
        client.closed().await;
        notices.await.unwrap();
    });
    host.retire_registered();
    assert!(host.wait_for_exit().success());

    // Restart the same synthetic Root to obtain a healthy VM and a new target.
    // The TUI must still recover the original operation, never re-submit it.
    fixture::serve(&mut host);
    let (client, notices) = runtime.block_on(fixture::connect(&host.root));
    let mut reopened = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
    reopened.wait_for("Check original submission");
    reopened.wait_until(|screen| {
        screen.contains("Exact original payload")
            && !screen.contains("connecting")
            && !screen.contains("not connected")
            && !screen.contains("connection failed")
    });
    let before = runtime.block_on(stats(&client));
    assert_eq!(before["business"]["count"], 1);
    assert_eq!(
        before["original"]["submissions"], 1,
        "restart never resubmits"
    );
    assert_eq!(before["recoveries"], json!([]));
    reopened.click_text("Check original submission");
    reopened.wait_for("Recovered original: Exact original payload");
    let settled = runtime.block_on(stats(&client));
    assert_eq!(settled["recoveries"], json!([operation]));
    assert_eq!(settled["business"]["count"], 1);
    assert_eq!(
        settled["original"], committed,
        "recovery only reads the original receipt"
    );
    reopened.close_terminal();
    reopened.finish();
    assert!(
        checkpoint(directory.path(), &host.root_id)["apps"]
            .as_array()
            .unwrap()
            .iter()
            .all(|entry| entry["pending"]["input"]["revision"] != operation)
    );
    client.disconnect();
    runtime.block_on(async {
        client.closed().await;
        notices.await.unwrap();
    });
    host.retire_registered();
    assert!(host.wait_for_exit().success());
}

async fn install(client: &maka_client::Client, directory: &Path, operation: &str) {
    let package = directory.join("plugin");
    std::fs::create_dir(&package).unwrap();
    std::fs::write(
        package.join("host.mjs"),
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../runtime-host/tests/fixtures/terminal-mutation-fault.mjs"
        ))
        .replace("__MUTATION_OPERATION__", operation),
    )
    .unwrap();
    std::fs::write(
        package.join("mutation-ui.mjs"),
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../runtime-host/tests/fixtures/mutation-ui.mjs"
        )),
    )
    .unwrap();
    std::fs::write(
        package.join("maka.extension.json"),
        json!({
            "schemaVersion":1,"id":PACKAGE,
            "runtime":{"entry":"host.mjs","sdkVersion":2,"vm":"dedicated"}
        })
        .to_string(),
    )
    .unwrap();
    client
        .request(
            Operation::PluginPackageInstall,
            json!({"sourcePath":package}),
        )
        .await
        .unwrap();
    client
        .request(
            Operation::PluginCompositionApply,
            json!({"operations":[{
                "type":"insert","rootId":"profile","entry":{"id":PACKAGE,"packageId":PACKAGE}
            }]}),
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while fixture::remote(client, PACKAGE, "stats", Value::Null)
            .await
            .is_err()
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

async fn stats(client: &maka_client::Client) -> Value {
    fixture::remote(client, PACKAGE, "stats", Value::Null)
        .await
        .unwrap()
}

async fn record(root: &Path, key: &str) -> Option<Value> {
    use sqlx::Connection;
    let mut db = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new()
            .filename(root.join(maka_event_log::root::ROOT_DATABASE))
            .read_only(true),
    )
    .await
    .unwrap();
    let raw: Option<String> = sqlx::query_scalar(
        "SELECT value_json FROM plugin_data WHERE package_id=? AND key=? AND value_json IS NOT NULL",
    ).bind(PACKAGE).bind(key).fetch_optional(&mut db).await.unwrap();
    db.close().await.unwrap();
    raw.map(|raw| serde_json::from_str(&raw).unwrap())
}

fn checkpoint(directory: &Path, root: &str) -> Value {
    serde_json::from_slice(
        &std::fs::read(
            directory
                .join("tui-state")
                .join(root)
                .join("default/state.json"),
        )
        .unwrap(),
    )
    .unwrap()
}

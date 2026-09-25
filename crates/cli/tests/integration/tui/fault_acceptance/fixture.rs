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

pub(crate) const FAULT: &str = "example.acceptance-fault";
pub(crate) const SHARED: &str = "example.acceptance-shared";
pub(crate) const DEDICATED: &str = "example.acceptance-dedicated";

pub(crate) fn serve(host: &mut CandidateFixture) {
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
}

pub(crate) async fn connect(
    root: &std::path::Path,
) -> (maka_client::Client, tokio::task::JoinHandle<()>) {
    let discovery = maka_client::local::read_discovery(root).unwrap();
    let (client, mut notices) = maka_client::Client::connect(
        maka_client::local::open_stream(&discovery.endpoint)
            .await
            .unwrap(),
        &discovery.root_id,
        &discovery.host_epoch,
        maka_client::Operations,
    )
    .await
    .unwrap();
    let task = tokio::spawn(async move { while notices.recv().await.is_some() {} });
    (client, task)
}

pub(crate) async fn install(
    client: &maka_client::Client,
    directory: &std::path::Path,
    package_id: &str,
    title: &str,
    vm: &str,
) {
    let package = directory.join(package_id);
    std::fs::create_dir(&package).unwrap();
    std::fs::write(
        package.join("host.mjs"),
        include_str!("../../../fixtures/faults-plugin/host.mjs")
            .replace("__ACCEPTANCE_TITLE__", title),
    )
    .unwrap();
    let mut runtime = json!({"entry":"host.mjs", "sdkVersion":2});
    // Omission deliberately exercises the Host's production Shared default.
    if vm == "dedicated" {
        runtime["vm"] = json!(vm);
    }
    std::fs::write(
        package.join("faults-ui.mjs"),
        include_str!("../../../fixtures/faults-plugin/faults-ui.mjs"),
    )
    .unwrap();
    std::fs::write(
        package.join("maka.extension.json"),
        json!({"schemaVersion":1,"id":package_id,"runtime":runtime}).to_string(),
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
                "type":"insert","rootId":"profile","entry":{"id":package_id,"packageId":package_id}
            }]}),
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if remote(client, package_id, "ping", Value::Null)
                .await
                .is_ok()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("acceptance package activation");
}

/// Close the exact document even if the callback fails or exceeds its deadline.
pub(crate) async fn remote(
    client: &maka_client::Client,
    package: &str,
    method: &str,
    input: Value,
) -> Result<Value, String> {
    let binding = RemoteBinding::Package {
        package_id: package.into(),
        method: method.into(),
        session_id: None,
    };
    let RemoteResult::Bound { target, .. } = client
        .plugin_remote(RemoteRequest::Bind {
            binding: binding.clone(),
        })
        .await
        .map_err(|error| error.to_string())?
    else {
        return Err("not bound".into());
    };
    let RemoteResult::Document { document } = client
        .plugin_remote(RemoteRequest::OpenDocument)
        .await
        .map_err(|error| error.to_string())?
    else {
        return Err("no document".into());
    };
    let result = tokio::time::timeout(
        Duration::from_secs(8),
        client.plugin_remote(RemoteRequest::Call {
            binding,
            target,
            document,
            input,
        }),
    )
    .await;
    let close = client
        .plugin_remote(RemoteRequest::CloseDocument { document })
        .await;
    close.map_err(|error| format!("document close: {error}"))?;
    match result {
        Ok(Ok(RemoteResult::Value { value })) => Ok(value),
        other => Err(format!("{other:?}")),
    }
}

pub(crate) fn position(screen: &str, text: &str) -> Option<(usize, usize)> {
    screen
        .lines()
        .enumerate()
        .find_map(|(row, line)| line.find(text).map(|byte| (row, line[..byte].width())))
}

pub(crate) fn click(screen: &str, text: &str) -> Vec<u8> {
    let (row, col) = position(screen, text).unwrap_or_else(|| panic!("missing {text}: {screen}"));
    format!(
        "\x1b[<0;{};{}M\x1b[<0;{};{}m",
        col + 1,
        row + 1,
        col + 1,
        row + 1
    )
    .into_bytes()
}

/// Observe the callback's committed entry marker outside its potentially busy VM.
/// This is read-only inspection of this fixture's fresh synthetic Root only.
pub(crate) async fn entered(root: &std::path::Path, arm: u64) -> Value {
    use sqlx::Connection;
    let mut db = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new()
            .filename(root.join(maka_event_log::root::ROOT_DATABASE))
            .read_only(true),
    )
    .await
    .unwrap();
    let result = tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let raw: Option<String> = sqlx::query_scalar(
                "SELECT value_json FROM plugin_data WHERE package_id=? AND key=? AND value_json IS NOT NULL",
            ).bind(FAULT).bind(format!("acceptance/entered/{arm}"))
                .fetch_optional(&mut db).await.unwrap();
            if let Some(raw) = raw { break serde_json::from_str::<Value>(&raw).unwrap(); }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    }).await;
    db.close().await.unwrap();
    result.expect("the actual fault callback must enter before local-input samples")
}

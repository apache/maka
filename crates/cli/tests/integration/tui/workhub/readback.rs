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
use std::path::Path;

pub(super) async fn remote(
    client: &maka_client::Client,
    package: &str,
    method: &str,
    input: Value,
) -> Value {
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
        .unwrap()
    else {
        panic!("bound {package}/{method}")
    };
    let RemoteResult::Document { document } = client
        .plugin_remote(RemoteRequest::OpenDocument)
        .await
        .unwrap()
    else {
        panic!("document")
    };
    let result = client
        .plugin_remote(RemoteRequest::Call {
            binding,
            target,
            document,
            input,
        })
        .await
        .unwrap();
    client
        .plugin_remote(RemoteRequest::CloseDocument { document })
        .await
        .unwrap();
    let RemoteResult::Value { value } = result else {
        panic!("value")
    };
    value
}

pub(super) async fn hub(client: &maka_client::Client, method: &str, input: Value) -> Value {
    remote(client, "maka.workhub", method, input).await
}

pub(super) async fn assignment(
    client: &maka_client::Client,
    title: &str,
    completed: bool,
) -> Value {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let page = hub(client, "assignments", json!({"after":null})).await;
            if let Some(entry) = page["entries"]
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["title"] == title)
            {
                if !completed {
                    return entry.clone();
                }
                let feedback = hub(client, "feedback", json!([entry["operationId"]])).await;
                if feedback[0]["state"] == "completed" {
                    return entry.clone();
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("WorkHub task {title} did not settle (completed={completed})"))
}

pub(super) fn source_session(entry: &Value) -> String {
    invocation_session(&entry["source"])
}

pub(super) fn session(entry: &Value) -> String {
    invocation_session(&entry["delivery"]["receipt"]["invocation"])
}

fn invocation_session(value: &Value) -> String {
    serde_json::from_value::<maka_runtime::event::Invocation>(value.clone())
        .expect("WorkHub returns the canonical runtime Invocation")
        .session_id
}

// Independent read-only inspection checks the immutable creation operation,
// which intentionally is not exposed by WorkHub's summary-only Remote method.
pub(super) async fn frozen_request(root: &Path, assignment: &str) -> Value {
    use sqlx::Connection;
    let mut db = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new()
            .filename(root.join(maka_event_log::root::ROOT_DATABASE))
            .read_only(true),
    )
    .await
    .unwrap();
    let raw: String = sqlx::query_scalar("SELECT value_json FROM plugin_data WHERE package_id='maka.workhub' AND key LIKE 'assignments/%' AND json_extract(value_json,'$.request.operationId')=?")
        .bind(assignment).fetch_one(&mut db).await.unwrap();
    db.close().await.unwrap();
    serde_json::from_str::<Value>(&raw).unwrap()["request"].clone()
}

pub(super) async fn remove_worker_model(client: &maka_client::Client) {
    let catalog = client
        .connection_catalog(maka_protocol::configuration::ConnectionCatalogQueryInput::Start)
        .await
        .unwrap();
    let connection = &catalog["items"][0];
    client.request(Operation::ConnectionCatalogUpdate, json!({
        "expected":{"connectionId":connection["connectionId"],"revision":connection["revision"]},
        "changes":{"name":connection["name"],"configuration":connection["configuration"],"enabled":true,"enabledModelIds":["fixture-model"]}
    })).await.unwrap();
}

pub(super) fn binary_digest() -> Vec<u8> {
    use sha2::{Digest, Sha256};
    let mut binary = File::open(env!("CARGO_BIN_EXE_maka")).unwrap();
    let mut digest = Sha256::new();
    let mut bytes = [0; 65536];
    loop {
        let count = binary.read(&mut bytes).unwrap();
        if count == 0 {
            break;
        }
        digest.update(&bytes[..count]);
    }
    digest.finalize().to_vec()
}

pub(super) async fn creation(root: &Path) -> Option<Value> {
    use sqlx::Connection;
    let mut db = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new()
            .filename(root.join(maka_event_log::root::ROOT_DATABASE))
            .read_only(true),
    )
    .await
    .unwrap();
    let raw: Option<String> = sqlx::query_scalar(
        "SELECT value_json FROM plugin_data WHERE package_id='maka.workhub' AND key='creation'",
    )
    .fetch_optional(&mut db)
    .await
    .unwrap();
    db.close().await.unwrap();
    raw.map(|value| serde_json::from_str(&value).unwrap())
}

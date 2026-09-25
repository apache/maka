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

#![cfg(unix)]

use maka_event_log::{
    EventLog,
    root::{RootNamespaces, RootOwner},
};
use maka_runtime::{event::Fact, execution::ThinkingLevel};
use maka_runtime_host::{
    server::{Host, local::LocalListener},
    session::SessionConfiguration,
};
use sqlx::Connection;
use std::{os::unix::fs::PermissionsExt, path::Path, process::Command, time::Duration};
use tokio_util::sync::CancellationToken;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn original_client_relay_profiles_reach_http_and_reopen_exact_facts() {
    let directory = tempfile::Builder::new()
        .prefix("maka-relay-")
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir_in("/tmp")
        .unwrap();
    let ns = RootNamespaces {
        ownership: directory.path().join("owners"),
        control: directory.path().join("control"),
    };
    let root = directory.path().join("root");
    let workspace = directory.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let owner = RootOwner::create(&root, &ns).unwrap();
    let root_id = owner.root_id().to_owned();
    seed_catalog(owner, &root).await;
    let mut original = None;
    for reopened in [false, true] {
        let host = Host::open(RootOwner::open(&root, &ns).unwrap())
            .await
            .unwrap();
        let socket = directory.path().join("h.sock");
        let listener = LocalListener::bind(&socket).unwrap();
        let cancellation = CancellationToken::new();
        let server = tokio::spawn(listener.serve(host, cancellation.clone()));
        let probe = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/client.mjs");
        let client_workspace = workspace.clone();
        let expected_id = root_id.clone();
        let client = tokio::task::spawn_blocking(move || {
            let mut command = Command::new("node");
            command
                .arg(probe)
                .arg("--socket")
                .arg(socket)
                .args(["--root-id", &expected_id])
                .arg("--relay-workspace")
                .arg(client_workspace);
            if reopened {
                command.arg("--reopened");
            }
            command.output().unwrap()
        });
        let output = tokio::time::timeout(Duration::from_secs(30), client)
            .await
            .unwrap()
            .unwrap();
        cancellation.cancel();
        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(
            output.status.success(),
            "stdout: {}\nstderr: {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            String::from_utf8_lossy(&output.stdout).contains(if reopened {
                "relay-options-reopened"
            } else {
                "relay-options-passed"
            })
        );
        let log = EventLog::open(&root.join(maka_event_log::root::ROOT_DATABASE))
            .await
            .unwrap();
        let prefix = log.prefix(1000, 1024 * 1024).await.unwrap();
        assert_eq!(
            prefix
                .events
                .iter()
                .filter(|stored| matches!(stored.event.fact, Fact::InvocationOpened { .. }))
                .count(),
            7,
            "rejected admissions create no invocation facts"
        );
        for wire in [
            "unknown-relay",
            "relay-gpt-5-2",
            "gpt-5-relay",
            "gpt-5-nano",
            "plain-model",
        ] {
            let current = log
                .get_session::<SessionConfiguration>(wire)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(current.configuration.thinking_level, None);
            let levels: Vec<_> = prefix
                .events
                .iter()
                .filter_map(|stored| {
                    let Fact::InvocationOpened { configuration, .. } = &stored.event.fact else {
                        return None;
                    };
                    if !stored.event.invocation.turn_id.starts_with(wire) {
                        return None;
                    }
                    let configuration = configuration
                        .as_ref()
                        .expect("opening freezes configuration");
                    assert_eq!(
                        configuration.model.as_ref(),
                        current.configuration.target.model()
                    );
                    Some(configuration.thinking_level)
                })
                .collect();
            assert_eq!(
                levels,
                if wire == "unknown-relay" {
                    vec![Some(ThinkingLevel::High), Some(ThinkingLevel::Max), None]
                } else {
                    vec![None]
                },
                "later updates must not rewrite earlier invocation contexts"
            );
        }
        let bytes = serde_json::to_vec(&prefix).unwrap();
        if let Some(original) = &original {
            assert_eq!(
                &bytes, original,
                "reopen preserves canonical facts and raw-byte digest"
            );
        } else {
            original = Some(bytes);
        }
        log.close().await.unwrap();
    }
}

// The public connection draft has no discovered-model field. Seed that persisted
// inventory offline; all credentials, Session changes, turns and queries use the
// unchanged public client once the Host opens it.
async fn seed_catalog(owner: RootOwner, root: &Path) {
    let store = maka_config::ConfigurationStore::for_root(std::sync::Arc::new(owner))
        .await
        .unwrap();
    store.close().await.unwrap();
    let reservation = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}/v1", reservation.local_addr().unwrap());
    let mut db = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new().filename(root.join("configuration-rust.sqlite")),
    )
    .await
    .unwrap();
    let id = "00000000-0000-4000-8000-000000000001";
    let models = [
        "unknown-relay",
        "relay/gpt-5.2",
        "gpt-5-relay",
        "gpt-5-nano",
        "plain-model",
    ];
    let document = serde_json::json!({
        "connectionId": id, "revision": 1, "slug": "relay", "name": "Relay",
        "provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"openai-responses-compatible"},
        "configuration":{"baseUrl":base_url}, "enabled": true,
        "enabledModelIds": models, "modelSource": "fetched", "modelsFetchedAt": 1,
        "models": models.iter().map(|model| serde_json::json!({
            "id": model, "contextWindow":400000, "capabilities": {
                "parallelToolCalls": *model != "unknown-relay", "vision": false
            }
        })).collect::<Vec<_>>()
    });
    sqlx::query(
        "INSERT INTO connections(connection_id, slug, revision, document) VALUES (?, 'relay', 1, ?)",
    )
    .bind(id)
    .bind(document.to_string())
    .execute(&mut db)
    .await
    .unwrap();
    sqlx::query("UPDATE connection_catalog SET revision = 1")
        .execute(&mut db)
        .await
        .unwrap();
    db.close().await.unwrap();
}

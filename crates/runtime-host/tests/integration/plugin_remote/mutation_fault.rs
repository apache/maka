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

use super::{ready, response, rpc, success};
use crate::support::{client_probe::ClientFixture, peer::Peer};
use maka_runtime_host::server::{Host, local::LocalListener};
use rusqlite::OptionalExtension;
use serde_json::{Value, json};
use std::{path::Path, time::Duration};
use tokio_util::sync::CancellationToken;

const PACKAGE: &str = "example.mutation-fault";

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn terminal_submit_preserves_unknown_outcomes_and_cleanup_fences() {
    tokio::time::timeout(Duration::from_secs(35), scenario())
        .await
        .unwrap();
}

async fn scenario() {
    let fixture = ClientFixture::new("maka-terminal-mutation-");
    let package = fixture.workspace.join("plugin");
    std::fs::create_dir(&package).unwrap();
    std::fs::write(
        package.join("host.mjs"),
        include_str!("../../fixtures/terminal-mutation-fault.mjs"),
    )
    .unwrap();
    std::fs::write(
        package.join("mutation-ui.mjs"),
        include_str!("../../fixtures/mutation-ui.mjs"),
    )
    .unwrap();
    std::fs::write(
        package.join("maka.extension.json"),
        json!({"schemaVersion":1,"id":PACKAGE,
            "runtime":{"entry":"host.mjs","sdkVersion":2,"vm":"dedicated"}})
        .to_string(),
    )
    .unwrap();
    let owner = fixture.owner();
    let root = owner.canonical_path().to_owned();
    let host = Host::open(owner).await.unwrap();
    #[cfg(unix)]
    let endpoint = fixture.workspace.parent().unwrap().join("mutation.sock");
    #[cfg(windows)]
    let endpoint = std::path::PathBuf::from(format!(r"\\.\pipe\mutation-{}", uuid::Uuid::new_v4()));
    let stop = CancellationToken::new();
    let cleanup = stop.clone().drop_guard();
    let server = tokio::spawn(
        LocalListener::bind(&endpoint)
            .unwrap()
            .serve(host.clone(), stop.clone()),
    );
    let mut peer = Peer::new(host, "mutation-client").await;
    success(
        peer.rpc("plugin.package.install", json!({"sourcePath":package}))
            .await,
    );
    success(
        peer.rpc(
            "plugin.composition.apply",
            json!({"operations":[
                {"type":"insert","rootId":"profile","entry":{"id":PACKAGE,"packageId":PACKAGE}}
            ]}),
        )
        .await,
    );
    ready(&mut peer).await;
    let binding = json!({"packageId":PACKAGE,"method":"terminal","sessionId":null});
    let target = rpc(&mut peer, json!({"kind":"bind","binding":binding})).await["target"].clone();
    let active_document = document(&mut peer).await;
    let mut request = json!({"kind":"call","binding":binding,"target":target,
        "document":active_document,"input":submit("rejected-before-admission")});
    request["target"]["registration"] = json!(uuid::Uuid::new_v4());
    assert_eq!(
        peer.rpc("plugin.remote", request.clone()).await["error"]["code"],
        "operation_conflict"
    );
    request["target"] = target;
    request["input"] = json!({"kind":"submit"});
    assert_eq!(
        peer.rpc("plugin.remote", request.clone()).await["error"]["code"],
        "invalid_request"
    );
    for (action, expected) in [
        ("known-conflict", "conflict"),
        ("known-rejected", "rejected"),
    ] {
        request["input"] = submit(action);
        assert_eq!(
            rpc(&mut peer, request.clone()).await["value"]["kind"],
            expected
        );
    }
    assert!(
        record(&root, "business").is_none(),
        "known refusals never ran a mutation"
    );
    rpc(
        &mut peer,
        json!({"kind":"close_document","document":active_document}),
    )
    .await;
    for action in ["throw", "oversized"] {
        let failed = document(&mut peer).await;
        request["document"] = failed.clone();
        request["input"] = submit(action);
        assert_eq!(
            peer.rpc("plugin.remote", request.clone()).await["error"]["code"],
            "outcome_unknown"
        );
        assert_eq!(
            record(&root, &format!("operations/{action}")).unwrap()["submissions"],
            1
        );
        let mut recovery = request.clone();
        recovery["input"] = json!({"kind":"recover","route":{"operation":action},"locale":"en"});
        assert_eq!(
            peer.rpc("plugin.remote", recovery.clone()).await["error"]["code"],
            "operation_conflict",
            "the failed UI document cannot accept another invocation"
        );
        rpc(
            &mut peer,
            json!({"kind":"close_document","document":failed}),
        )
        .await;
        let recovered = document(&mut peer).await;
        recovery["document"] = recovered.clone();
        assert_eq!(
            rpc(&mut peer, recovery).await["value"]["route"]["operation"],
            action
        );
        rpc(
            &mut peer,
            json!({"kind":"close_document","document":recovered}),
        )
        .await;
    }

    // A cancelled callback has already committed; successful resource settlement
    // cannot turn the lost business result into proof that nothing happened.
    let cancelled = document(&mut peer).await;
    request["document"] = cancelled.clone();
    request["input"] = submit("cancel");
    peer.send_rpc("cancelled-submit", "plugin.remote", request.clone());
    entered(&root, "cancel").await;
    peer.send_rpc(
        "cancel-document",
        "plugin.remote",
        json!({"kind":"close_document","document":cancelled}),
    );
    let replies = [response(&mut peer).await, response(&mut peer).await];
    assert!(
        replies
            .iter()
            .any(|reply| reply["requestId"] == "cancelled-submit"
                && reply["error"]["code"] == "outcome_unknown"),
        "{replies:?}"
    );
    assert!(
        replies
            .iter()
            .any(|reply| reply["requestId"] == "cancel-document" && reply["ok"] == true),
        "{replies:?}"
    );

    let failed = document(&mut peer).await;
    request["document"] = failed.clone();
    request["input"] = submit("runaway");
    peer.send_rpc("runaway-submit", "plugin.remote", request.clone());
    entered(&root, "runaway").await;
    let failure = response(&mut peer).await;
    assert_eq!(failure["requestId"], "runaway-submit");
    assert_eq!(failure["error"]["code"], "outcome_unknown", "{failure}");
    assert_eq!(record(&root, "business").unwrap()["count"], 4);
    assert_eq!(
        record(&root, "operations/runaway").unwrap()["submissions"],
        1
    );
    // The wire classification must not erase either cleanup fence.
    let close = peer
        .rpc(
            "plugin.remote",
            json!({"kind":"close_document","document":failed}),
        )
        .await;
    assert_eq!(close["error"]["code"], "operation_unavailable", "{close}");
    let retired = peer
        .rpc("plugin.remote", json!({"kind":"bind","binding":binding}))
        .await;
    assert_eq!(retired["error"]["code"], "operation_conflict", "{retired}");
    peer.close().await;
    stop.cancel();
    server.await.unwrap().unwrap();
    cleanup.disarm();
}

fn submit(action: &str) -> Value {
    json!({"kind":"submit","route":null,"revision":action,"action":action,
        "fields":{"note":"Original durable mutation"},"grant":null,"locale":"en"})
}

async fn document(peer: &mut Peer) -> Value {
    rpc(peer, json!({"kind":"open_document"})).await["document"].clone()
}

fn record(root: &Path, key: &str) -> Option<Value> {
    let db = rusqlite::Connection::open_with_flags(
        root.join(maka_event_log::root::ROOT_DATABASE),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let raw: Option<String> = db.query_row(
        "SELECT value_json FROM plugin_data WHERE package_id=?1 AND key=?2 AND value_json IS NOT NULL",
        [PACKAGE, key], |row| row.get(0),
    ).optional().unwrap();
    raw.map(|raw| serde_json::from_str(&raw).unwrap())
}

async fn entered(root: &Path, operation: &str) {
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            if let Some(receipt) = record(root, &format!("operations/{operation}")) {
                assert_eq!(receipt["operation"], operation);
                assert_eq!(receipt["receipt"]["kind"], "applied");
                return;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("the real JS callback committed its mutation before the fault");
}

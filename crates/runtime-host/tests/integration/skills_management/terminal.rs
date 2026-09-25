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

use super::{Peer, Value, json};
use maka_plugins::terminal_ui::view::{Reply, Request, View};
use std::{collections::BTreeMap, path::Path};

mod authority;
mod changes;
mod source;
pub(super) use authority::credential;

#[derive(Default)]
pub(super) struct History {
    originals: Vec<(Request, Value, Value)>,
}
impl History {
    pub(super) async fn recover(&self, peer: &mut Peer, grant: &Value) {
        for (request, recovery, expected) in &self.originals {
            let reply = call(
                peer,
                Request::Recover {
                    route: recovery.clone(),
                    locale: "en".into(),
                },
            )
            .await;
            assert_eq!(
                serde_json::to_value(reply).unwrap(),
                *expected,
                "original outcome survives result deletion and Host reopen"
            );
            let mut request = request.clone();
            if let Request::Submit { grant: field, .. } = &mut request
                && field.is_some()
            {
                *field = Some(serde_json::from_value(grant.clone()).unwrap());
            }
            let repeated = call(peer, request).await;
            assert_eq!(
                serde_json::to_value(repeated).unwrap(),
                *expected,
                "original submission cannot reapply"
            );
        }
    }
    async fn submit(&mut self, peer: &mut Peer, view: &View, request: Request) {
        let Request::Submit { action, .. } = &request else {
            unreachable!()
        };
        let recovery = view.action(action).unwrap().recovery.clone().unwrap();
        let reply = call(peer, request.clone()).await;
        assert!(matches!(reply, Reply::Applied { .. }), "{reply:?}");
        let expected = serde_json::to_value(reply).unwrap();
        self.originals.push((request, recovery, expected));
    }
}
fn verify(installed: &Path, bytes: &str) {
    assert_eq!(
        std::fs::read(installed.join("SKILL.md")).unwrap(),
        bytes.as_bytes()
    );
    assert_eq!(
        std::fs::read(installed.join(".maka/baseline/SKILL.md")).unwrap(),
        bytes.as_bytes()
    );
    let lock: Value =
        serde_json::from_slice(&std::fs::read(installed.join("skill.lock.json")).unwrap()).unwrap();
    assert_eq!(
        lock["contentSha256"],
        maka_runtime::artifact::content_digest(bytes.as_bytes())
    );
}
async fn read(peer: &mut Peer, route: Value, locale: &str) -> View {
    let Reply::View { view } = call(
        peer,
        Request::Read {
            route,
            locale: locale.into(),
        },
    )
    .await
    else {
        panic!("Skill library view");
    };
    view
}
async fn call(peer: &mut Peer, input: Request) -> Reply {
    let response = raw(peer, input).await;
    assert_eq!(response["ok"], true, "{response}");
    let reply: Reply = serde_json::from_value(response["result"]["value"].clone()).unwrap();
    reply.validate().unwrap();
    reply
}
async fn raw(peer: &mut Peer, input: Request) -> Value {
    raw_value(
        peer,
        "terminal-library",
        serde_json::to_value(input).unwrap(),
    )
    .await
}
async fn raw_value(peer: &mut Peer, method: &str, input: Value) -> Value {
    let binding = json!({"packageId":"maka.skills","method":method,"sessionId":"skill-library"});
    let bound = peer
        .rpc("plugin.remote", json!({"kind":"bind","binding":binding}))
        .await;
    assert_eq!(bound["ok"], true, "{bound}");
    let opened = peer
        .rpc("plugin.remote", json!({"kind":"open_document"}))
        .await;
    assert_eq!(opened["ok"], true, "{opened}");
    let document = &opened["result"]["document"];
    let reply = peer.rpc("plugin.remote", json!({"kind":"call","binding":binding,"target":bound["result"]["target"],"document":document,"input":input})).await;
    let closed = peer
        .rpc(
            "plugin.remote",
            json!({"kind":"close_document","document":document}),
        )
        .await;
    assert_eq!(closed["ok"], true, "{closed}");
    reply
}

/// Reconstruct the genuine journal cut after publishing its target and before
/// persisting its receipt. The original reservation and operation remain intact.
fn publication_gap(
    directory: &Path,
    private: &Path,
    transactions: &Path,
    stamp: &str,
    entries: &[&str],
) -> std::path::PathBuf {
    use maka_runtime::artifact::content_digest;
    let operation = uuid::Uuid::parse_str(stamp.split(':').nth(1).unwrap()).unwrap();
    let receipt = private.join(format!("receipts/{operation}.json"));
    let record: Value = serde_json::from_slice(&std::fs::read(&receipt).unwrap()).unwrap();
    let mut manifest = BTreeMap::new();
    for path in entries {
        let file = directory.join(path);
        if file.is_dir() {
            manifest.insert(*path, json!({"kind":"directory"}));
            continue;
        }
        #[cfg(unix)]
        let mode = {
            use std::os::unix::fs::PermissionsExt;
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777
        };
        #[cfg(windows)]
        let mode = 0o600;
        manifest.insert(
            *path,
            json!({"kind":"file","hash":content_digest(&std::fs::read(file).unwrap()),"mode":mode}),
        );
    }
    let intent = serde_json::to_vec(&json!({"schema":1,"id":directory.file_name().unwrap().to_str().unwrap(),"expected":null,"next":manifest,"operation":{"operation":record["operation"],"destination":record["outcome"]["destination"]}})).unwrap();
    let hash = content_digest(&intent);
    let transaction = transactions.join(format!("tx-{}-{}", uuid::Uuid::new_v4(), &hash[7..]));
    std::fs::create_dir(&transaction).unwrap();
    std::fs::write(transaction.join("intent.json"), intent).unwrap();
    std::fs::remove_file(receipt).unwrap();
    transaction
}

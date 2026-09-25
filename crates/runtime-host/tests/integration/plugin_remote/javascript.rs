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

use super::{ready, rpc, success};
use crate::support::{client_probe::ClientFixture, peer::Peer};
use maka_runtime_host::server::{Host, local::LocalListener};
use serde_json::{Value, json};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

mod client;

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn javascript_remote_replaces_exact_registration_and_closes_late_vm_streams() {
    tokio::time::timeout(Duration::from_secs(45), async {
        for vm in ["shared", "dedicated"] {
            scenario(vm).await;
        }
    })
    .await
    .unwrap();
}
async fn scenario(vm: &str) {
    let fixture = ClientFixture::new("maka-js-remote-");
    let database_path = fixture.workspace.join("source.sqlite");
    let source = rusqlite::Connection::open(&database_path).unwrap();
    source.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE source(value INTEGER); INSERT INTO source VALUES(7)").unwrap();
    source
        .execute_batch("CREATE TABLE large(payload TEXT)")
        .unwrap();
    source
        .execute("INSERT INTO large VALUES(?1)", ["0".repeat(1_000_000)])
        .unwrap();
    let canonical_workspace = fixture.workspace.canonicalize().unwrap();
    let expected_cwd = maka_fs_tools::workspace::project::host_path(&canonical_workspace).unwrap();
    let path = fixture.workspace.join("plugin");
    std::fs::create_dir(&path).unwrap();
    std::fs::write(
        path.join("host.mjs"),
        include_str!("../../fixtures/remote-plugin.mjs"),
    )
    .unwrap();
    std::fs::write(
        path.join("echo-ui.mjs"),
        include_str!("../../fixtures/echo-ui.mjs"),
    )
    .unwrap();
    std::fs::write(path.join("client.js"), "immutable client fixture").unwrap();
    std::fs::write(
        path.join("maka.extension.json"),
        serde_json::to_vec(&json!({
            "schemaVersion":1,"id":"example.remote",
            "runtime":{"entry":"host.mjs","sdkVersion":2,"vm":vm},
            "client":{"entry":"client.js","sdkVersion":1},
        }))
        .unwrap(),
    )
    .unwrap();
    let owner = fixture.owner();
    let denied_path = owner.canonical_path().join("private.sqlite");
    rusqlite::Connection::open(&denied_path)
        .unwrap()
        .execute_batch("CREATE TABLE source(value INTEGER)")
        .unwrap();
    let host = Host::open(owner).await.unwrap();
    #[cfg(unix)]
    let endpoint = fixture.workspace.parent().unwrap().join("js-remote.sock");
    #[cfg(windows)]
    let endpoint =
        std::path::PathBuf::from(format!(r"\\.\pipe\maka-js-remote-{}", uuid::Uuid::new_v4()));
    let stop = CancellationToken::new();
    let cleanup = stop.clone().drop_guard();
    let server = tokio::spawn(
        LocalListener::bind(&endpoint)
            .unwrap()
            .serve(host.clone(), stop.clone()),
    );
    let mut peer = Peer::new(host.clone(), "js-remote-client").await;
    success(
        peer.rpc("plugin.package.install", json!({"sourcePath":path}))
            .await,
    );
    success(peer.rpc("plugin.composition.apply",json!({"operations":[
        {"type":"insert","rootId":"profile","entry":{"id":"remote-host","packageId":"example.remote"}},
        {"type":"insert","rootId":"desktop-ui","entry":{"id":"remote-ui","packageId":"example.remote"}}
    ]})).await);
    ready(&mut peer).await;
    let page = success(
        peer.rpc("plugin.client.query", json!({"kind":"snapshot"}))
            .await,
    );
    let entry = page["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["entryId"] == "remote-ui")
        .unwrap();
    let client = json!({"entryId":entry["entryId"],"extensionId":entry["extensionId"],"activation":entry["activation"],
        "contentDigest":entry["contentDigest"],"clientDigest":entry["clientDigest"]});
    let document = rpc(&mut peer, json!({"kind":"open_document"})).await["document"].clone();
    let (storage, storage_target) = bind(&mut peer, &client, "storage-budget").await;
    let budget = rpc(
        &mut peer,
        json!({"kind":"call", "binding":storage,
        "target":storage_target, "document":document, "input":null}),
    )
    .await;
    assert_eq!(budget["value"], json!({"written":13,"bytes":9_000_000}));
    let (uncertain, uncertain_target) = bind(&mut peer, &client, "uncertain").await;
    let failure = peer
        .rpc(
            "plugin.remote",
            json!({"kind":"call", "binding":uncertain,
        "target":uncertain_target, "document":document, "input":null}),
        )
        .await;
    assert_eq!(failure["error"]["code"], "outcome_unknown", "{failure}");
    let (uncertain, uncertain_target) = bind(&mut peer, &client, "uncertain-stream").await;
    let uncertain_stream = rpc(
        &mut peer,
        json!({"kind":"open", "binding":uncertain,
        "target":uncertain_target, "document":document, "input":null}),
    )
    .await["stream"]
        .clone();
    let failure = peer
        .rpc(
            "plugin.remote",
            json!({"kind":"next", "document":document,
        "stream":uncertain_stream}),
        )
        .await;
    assert_eq!(failure["error"]["code"], "outcome_unknown", "{failure}");
    rpc(
        &mut peer,
        json!({"kind":"close", "document":document, "stream":uncertain_stream}),
    )
    .await;
    // Business uncertainty does not fence a fully settled provider or revoke
    // the caller's document: normal calls below must still succeed.
    for (method, path, sql, allowed) in [
        (
            "database",
            &database_path,
            "SELECT value, ? AS precise, x'00ff' AS bytes FROM source",
            true,
        ),
        (
            "database",
            &database_path,
            "SELECT value, ? AS precise, x'00ff' AS bytes FROM source",
            true,
        ),
        ("denied-database", &database_path, "SELECT ?", false),
        ("database", &denied_path, "SELECT ?", false),
        (
            "database",
            &database_path,
            "UPDATE source SET value=?",
            false,
        ),
    ] {
        let (binding, target) = bind(&mut peer, &client, method).await;
        let result = peer.rpc("plugin.remote", json!({"kind":"call", "binding":binding, "target":target, "document":document,
            "input":{"path":path,"queries":[{"sql":sql,"parameters":[{"kind":"integer","value":"9223372036854775807"}]}]}})).await;
        assert_eq!(result["ok"], allowed, "{result}");
        if allowed {
            assert_eq!(
                result["result"]["value"][0]["rows"],
                json!([[{"kind":"integer","value":"7"},{"kind":"integer","value":"9223372036854775807"},{"kind":"blob","value":"AP8="}]])
            );
        }
    }
    assert_eq!(
        source
            .query_row("SELECT value FROM source", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        7
    );
    let (binding, target) = bind(&mut peer, &client, "database-summary").await;
    let large = peer.rpc("plugin.remote", json!({"kind":"call", "binding":binding, "target":target, "document":document,
        "input":{"path":database_path,"queries":[{"sql":"WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<35) SELECT payload FROM large,n"}]}})).await;
    if large["ok"] != true {
        let status = peer
            .rpc("plugin.platform.query", json!({"view":"failures"}))
            .await;
        panic!("{vm}: {large}; platform: {status}");
    }
    assert_eq!(large["result"]["value"], 35_000_000);
    for method in ["workspace", "workspace", "denied-workspace"] {
        let (binding, target) = bind(&mut peer, &client, method).await;
        let result = peer
            .rpc(
                "plugin.remote",
                json!({"kind":"call", "binding":binding,
            "target":target, "document":document, "input":fixture.workspace}),
            )
            .await;
        if method == "denied-workspace" {
            assert_eq!(result["ok"], false, "{result}");
            assert!(
                result["error"]["message"]
                    .as_str()
                    .unwrap()
                    .contains("does not allow Host paths"),
                "{result}"
            );
        } else {
            assert_eq!(success(result)["value"]["cwd"], expected_cwd);
        }
    }
    let (view_binding, view_target) = bind(&mut peer, &client, "workspace-stream").await;
    let view_stream = rpc(
        &mut peer,
        json!({"kind":"open", "binding":view_binding,
        "target":view_target,"document":document,"input":fixture.workspace}),
    )
    .await["stream"]
        .clone();
    let view = rpc(
        &mut peer,
        json!({"kind":"next","document":document,"stream":view_stream}),
    )
    .await;
    assert_eq!(view["item"]["cwd"], expected_cwd, "{view}");
    rpc(
        &mut peer,
        json!({"kind":"close","document":document,"stream":view_stream}),
    )
    .await;
    let (binding, target) = bind(&mut peer, &client, "echo").await;
    let (_, view_target) = bind(&mut peer, &client, "echo-view").await;
    let views = success(
        peer.rpc(
            "plugin.platform.query",
            json!({
                "view":"terminal_views", "rootId":"profile", "limit":1
            }),
        )
        .await,
    );
    let projected: maka_protocol::plugin::QueryResult =
        serde_json::from_value(views.clone()).unwrap();
    maka_protocol::plugin::decode_output(maka_protocol::Operation::PluginPlatformQuery, &views)
        .unwrap();
    let maka_protocol::plugin::QueryResult::TerminalViews(page) = projected else {
        panic!("terminal view page expected")
    };
    assert_eq!(page.items.len(), 1);
    let descriptor = &page.items[0];
    assert_eq!(descriptor.package_id, "example.remote");
    assert_eq!(descriptor.method, "echo-view");
    assert_eq!(
        serde_json::to_value(&descriptor.target).unwrap(),
        view_target
    );
    assert_eq!(descriptor.descriptor.title.resolve("zh-CN"), "回显");
    assert_eq!(descriptor.descriptor.title.resolve("zh-TW"), "回顯");
    let continuation = json!({"view":"terminal_views", "rootId":"profile", "limit":1,
        "cursor":page.next_cursor.unwrap()});
    let last = success(
        peer.rpc("plugin.platform.query", continuation.clone())
            .await,
    );
    assert_eq!(last["items"][0]["method"], "terminal-extra");
    // Builtins can contribute pages too; only this fixture's two registrations
    // are fixed. Continue the real directory without assuming it ends here.
    let mut cursor = last["nextCursor"].clone();
    let mut cursors = std::collections::HashSet::new();
    while !cursor.is_null() {
        assert!(cursors.insert(cursor.as_str().unwrap().to_owned()));
        assert!(cursors.len() < 64, "fixture directory must stay bounded");
        let page = success(
            peer.rpc(
                "plugin.platform.query",
                json!({
                    "view":"terminal_views", "rootId":"profile", "limit":1, "cursor":cursor
                }),
            )
            .await,
        );
        assert_eq!(page["items"].as_array().unwrap().len(), 1);
        assert_ne!(page["items"][0]["packageId"], "example.remote");
        cursor = page["nextCursor"].clone();
    }
    // Discovery pins a real presenter; its document stays separate from generic RPCs.
    let native_binding =
        json!({"packageId":"example.remote", "method":"echo-view", "sessionId":null});
    let view_document = rpc(&mut peer, json!({"kind":"open_document"})).await["document"].clone();
    let view = rpc(
        &mut peer,
        json!({"kind":"call", "binding":native_binding,
            "target":view_target,"document":view_document,
            "input":{"kind":"read","route":"from view","locale":"en"}}),
    )
    .await;
    assert_eq!(view["value"]["kind"], "view");
    assert_eq!(view["value"]["view"]["version"], 7);
    assert_eq!(
        view["value"]["view"]["root"]["spans"][0]["text"],
        "from view"
    );
    rpc(
        &mut peer,
        json!({"kind":"close_document","document":view_document}),
    )
    .await;
    let call = json!({"kind":"call","binding":binding,"target":target,"document":document,"input":"hello"});
    assert_eq!(rpc(&mut peer, call.clone()).await["value"]["generation"], 0);
    let (replace, replacement) = bind(&mut peer, &client, "replace").await;
    rpc(&mut peer,json!({"kind":"call","binding":replace,"target":replacement,"document":document,"input":null})).await;
    assert_eq!(
        peer.rpc("plugin.remote", call).await["error"]["code"],
        "operation_conflict"
    );
    let (_, next) = bind(&mut peer, &client, "echo").await;
    assert_eq!(
        peer.rpc("plugin.platform.query", continuation).await["error"]["code"],
        "stale_cursor"
    );
    let views = success(
        peer.rpc(
            "plugin.platform.query",
            json!({"view":"terminal_views","rootId":"profile"}),
        )
        .await,
    );
    let (_, next_view) = bind(&mut peer, &client, "echo-view").await;
    assert_eq!(views["items"][0]["target"], next_view);
    assert_eq!(view_target["activation"], next_view["activation"]);
    assert_ne!(view_target["registration"], next_view["registration"]);
    assert_eq!(target["activation"], next["activation"]);
    assert_ne!(target["registration"], next["registration"]);
    assert_eq!(
        rpc(
            &mut peer,
            json!({"kind":"call","binding":binding,"target":next,"document":document,"input":null})
        )
        .await["value"]["generation"],
        1
    );
    let (binding, target) = bind(&mut peer, &client, "events").await;
    let stream = rpc(
        &mut peer,
        json!({"kind":"open","binding":binding,"target":target,"document":document,"input":null}),
    )
    .await["stream"]
        .clone();
    assert_eq!(
        rpc(
            &mut peer,
            json!({"kind":"next","document":document,"stream":stream})
        )
        .await,
        json!({"kind":"item","item":null})
    );
    peer.send_rpc(
        "read",
        "plugin.remote",
        json!({"kind":"next","document":document,"stream":stream}),
    );
    peer.send_rpc(
        "close",
        "plugin.remote",
        json!({"kind":"close","document":document,"stream":stream}),
    );
    let replies = [
        super::response(&mut peer).await,
        super::response(&mut peer).await,
    ];
    assert!(
        replies
            .iter()
            .any(|reply| reply["requestId"] == "close" && reply["ok"] == true),
        "{replies:?}"
    );
    assert!(
        replies.iter().any(|reply| reply["requestId"] == "read"
            && (reply["error"]["code"] == "operation_conflict"
                || reply["result"]["kind"] == "end")),
        "{replies:?}"
    );
    let (stats, stats_target) = bind(&mut peer, &client, "stats").await;
    let status = rpc(&mut peer,json!({"kind":"call","binding":stats,"target":stats_target,"document":document,"input":null})).await;
    assert_eq!(status["value"]["active"], 0);
    assert_eq!(status["value"]["stopped"], 1);

    peer.send_rpc(
        "late",
        "plugin.remote",
        json!({"kind":"open","binding":binding,"target":target,"document":document,"input":"late"}),
    );
    loop {
        let status = rpc(&mut peer,json!({"kind":"call","binding":stats,"target":stats_target,"document":document,"input":null})).await;
        if status["value"]["opening"] == 1 {
            break;
        }
        tokio::task::yield_now().await;
    }
    peer.send_rpc(
        "end-page",
        "plugin.remote",
        json!({"kind":"close_document","document":document}),
    );
    let responses = [
        super::response(&mut peer).await,
        super::response(&mut peer).await,
    ];
    assert!(
        responses
            .iter()
            .any(|r| r["requestId"] == "end-page" && r["ok"] == true),
        "{responses:?}"
    );
    assert!(
        responses
            .iter()
            .any(|r| r["requestId"] == "late" && r["error"]["code"] == "operation_conflict"),
        "{responses:?}"
    );
    let document = rpc(&mut peer, json!({"kind":"open_document"})).await["document"].clone();
    let status = rpc(&mut peer,json!({"kind":"call","binding":stats,"target":stats_target,"document":document,"input":null})).await;
    assert_eq!(
        status["value"],
        json!({"generation":1,"opening":0,"active":0,"stopped":2})
    );
    client::verify(host, &endpoint).await;
    peer.close().await;
    stop.cancel();
    server.await.unwrap().unwrap();
    cleanup.disarm();
}
async fn bind(peer: &mut Peer, client: &Value, method: &str) -> (Value, Value) {
    let binding = json!({"client":client,"method":method,"sessionId":null});
    let target = rpc(peer, json!({"kind":"bind","binding":binding})).await["target"].clone();
    (binding, target)
}

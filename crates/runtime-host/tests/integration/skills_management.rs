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

mod terminal;

use super::{
    skills_plugin::{converged, disabled},
    support::{client_probe::ClientFixture, peer::Peer},
};
use maka_runtime::artifact::content_digest;
use maka_runtime_host::server::{Host, HostOptions, local::LocalListener};
use serde_json::{Value, json};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

async fn catalog(peer: &mut Peer, context: &Value, view: &str) -> Value {
    super::skills_plugin::client::workspace(
        peer,
        &context["workspace"]["path"],
        json!({"kind":"catalog","view":view}),
    )
    .await
}
async fn mutate(peer: &mut Peer, context: &Value, mutation: Value) -> Value {
    let basis = catalog(peer, context, "governance").await;
    super::skills_plugin::client::workspace(
        peer,
        &context["workspace"]["path"],
        json!({"kind":"mutate","expectedRevision":basis["revision"],"mutation":mutation}),
    )
    .await
}
fn document(body: &str) -> String {
    format!("---\nname: Review\ndescription: Review code\n---\n{body}\n")
}
async fn approve_user(peer: &mut Peer) -> Value {
    let status =
        super::skills_plugin::client::request(peer, "user-authorization", json!({"kind":"status"}))
            .await;
    super::skills_plugin::client::authorization(
        peer,
        json!({
            "kind":"approve","request":{
                "operationId":uuid::Uuid::new_v4(),"title":"Manage user Skills",
                "target":status["target"],"capabilities":["read_files","write_files"]
            }
        }),
    )
    .await["grant"]["id"]
        .clone()
}

async fn discovery_locations(peer: &mut Peer, workspace: &std::path::Path) {
    use super::skills_plugin::client::request;
    let first = workspace.join("location-project-a");
    let second = workspace.join("location-project-b");
    std::fs::create_dir_all(&first).unwrap();
    std::fs::create_dir_all(&second).unwrap();
    let registered = peer
        .rpc(
            "project.catalog.mutate",
            json!({"kind":"register","path":first}),
        )
        .await;
    assert_eq!(registered["ok"], true, "{registered}");
    let project = registered["result"]["project"]["id"].clone();
    let target = json!({"workspace":{"kind":"project","projectId":project},
        "sandboxMode":"workspace-write","collaborationMode":"agent"});
    let listed = request(
        peer,
        "locations",
        json!({"workspace":target,"action":{"kind":"list"}}),
    )
    .await;
    let locations = listed["locations"].as_array().unwrap();
    assert_eq!(locations.len(), 5);
    let agents = locations
        .iter()
        .find(|item| item["id"] == "project:agents")
        .unwrap();
    assert_eq!(agents["status"], "missing");
    assert_eq!(
        locations
            .iter()
            .find(|item| item["id"] == "user:maka")
            .unwrap()["validCount"],
        1
    );
    let open = json!({"kind":"open","id":"project:agents","expectedPath":agents["path"],"createIfMissing":false});
    let missing = request(peer, "locations", json!({"workspace":target,"action":open})).await;
    assert_eq!(missing["reason"], "missing");
    assert!(!first.join(".agents/skills").exists());
    let moved = peer
        .rpc(
            "project.catalog.mutate",
            json!({"kind":"relink","projectId":project,"path":second}),
        )
        .await;
    assert_eq!(moved["ok"], true, "{moved}");
    let mut open = open;
    open["createIfMissing"] = json!(true);
    let stale = request(peer, "locations", json!({"workspace":target,"action":open})).await;
    assert_eq!(stale["reason"], "changed");
    assert!(!first.join(".agents/skills").exists());
    assert!(!second.join(".agents/skills").exists());
    let refreshed = request(
        peer,
        "locations",
        json!({"workspace":target,"action":{"kind":"list"}}),
    )
    .await;
    open["expectedPath"] = refreshed["locations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == "project:agents")
        .unwrap()["path"]
        .clone();
    for _ in 0..2 {
        let result = request(peer, "locations", json!({"workspace":target,"action":open})).await;
        assert_eq!(result["kind"], "resolved", "{result}");
        assert!(second.join(".agents/skills").is_dir());
    }
    std::fs::create_dir_all(second.join(".maka")).unwrap();
    std::fs::write(second.join(".maka/skills"), b"not a directory").unwrap();
    let blocked = request(
        peer,
        "locations",
        json!({"workspace":target,"action":{"kind":"list"}}),
    )
    .await;
    assert_eq!(
        blocked["locations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == "project:maka")
            .unwrap()["status"],
        "blocked_path"
    );
    let removed = peer
        .rpc(
            "project.catalog.mutate",
            json!({"kind":"archive","projectId":project}),
        )
        .await;
    assert_eq!(removed["ok"], true, "{removed}");
    let missing = request(
        peer,
        "locations",
        json!({"workspace":target,"action":{"kind":"list"}}),
    )
    .await;
    for item in missing["locations"].as_array().unwrap() {
        if item["id"].as_str().unwrap().starts_with("project:") {
            assert_eq!(item["status"], "unavailable");
            assert!(item["path"].is_null());
        } else {
            assert_eq!(item["status"], "available", "{item}");
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn skill_publication_and_confirmed_update_work_through_host_without_a_model() {
    let fixture = ClientFixture::new("maka-skill-management-");
    // Browsing never executes a model; this unreachable fixture target only gives
    // the real Session its normal model configuration.
    let model = super::support::message_recovery::configure(&fixture, "http://127.0.0.1:1").await;
    let mut terminal = terminal::History::default();
    terminal::credential(&fixture).await;
    let home = fixture.workspace.parent().unwrap().join("home");
    let source = home.join(".maka/skill-sources/review");
    std::fs::create_dir_all(&home).unwrap();
    let original = document("Original");
    let updated = document("Updated");
    let local = document("Local edit");
    let import_file = fixture.workspace.join("import-source/review.md");
    std::fs::create_dir_all(import_file.parent().unwrap()).unwrap();
    std::fs::write(&import_file, &original).unwrap();
    std::fs::write(
        import_file.parent().unwrap().join("sibling.txt"),
        b"not imported",
    )
    .unwrap();
    for (base, id) in [(".maka", "user-review"), (".agents", "agent-review")] {
        let directory = home.join(base).join("skills").join(id);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("SKILL.md"), &original).unwrap();
    }
    let context = json!({"workspace":{"kind":"host_path","path":fixture.workspace}});
    let mut approved = Value::Null;
    let mut pending_recovery = None::<std::path::PathBuf>;
    for reopened in [false, true] {
        let owner = fixture.owner();
        let root = owner.canonical_path().to_owned();
        let host = Host::open_with_options(
            owner,
            None,
            HostOptions {
                skill_home: Some(home.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        #[cfg(unix)]
        let endpoint = fixture.workspace.parent().unwrap().join("management.sock");
        #[cfg(windows)]
        let endpoint = std::path::PathBuf::from(format!(
            r"\\.\pipe\maka-management-{}",
            uuid::Uuid::new_v4()
        ));
        let stop = CancellationToken::new();
        let cleanup = stop.clone().drop_guard();
        let websocket = maka_runtime_host::server::websocket::WebSocketListener::bind(
            "127.0.0.1:0".parse().unwrap(),
            vec![],
        )
        .await
        .unwrap();
        let address = websocket.local_addr().unwrap();
        let server = tokio::spawn(
            LocalListener::bind(&endpoint)
                .unwrap()
                .serve_with_websocket(websocket, host.clone(), stop),
        );
        let mut peer = Peer::new(host, "management").await;
        converged(&mut peer).await;
        if reopened {
            disabled(&mut peer, false).await;
        } else {
            let created = peer.rpc("session.create", json!({
                "sessionId":"skill-library", "workspace":{"kind":"host_path","path":fixture.workspace},
                "modelTarget":{"kind":"explicit","connectionId":model.connection_id,"connectionSlug":model.connection_slug,"model":model.model}
            })).await;
            assert_eq!(created["ok"], true, "{created}");
        }
        let namespace = std::fs::read_dir(root.join("plugin-data"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| path.join("skills").is_dir())
            .unwrap();
        let installed = namespace.join("skills/review");
        if reopened {
            let page = catalog(&mut peer, &context, "governance").await;
            assert!(page["userRecovery"].is_string(), "{page}");
            let pending = pending_recovery.as_ref().unwrap();
            assert!(
                pending.join("proof").is_file(),
                "revoked consent must leave pending files untouched"
            );
            approved = approve_user(&mut peer).await;
            let status = super::skills_plugin::client::request(
                &mut peer,
                "user-authorization",
                json!({"kind":"recover","grant":approved}),
            )
            .await;
            assert!(status["recovery"].is_null(), "{status}");
            assert!(
                !pending.exists(),
                "re-consent resumes the same durable publication"
            );
        }
        if !reopened {
            discovery_locations(&mut peer, &fixture.workspace).await;
            approved = terminal
                .import(&mut peer, &import_file, &source, &namespace, &original)
                .await;
            let grant = approved.clone();
            terminal.restricted(address, &mut peer, &source).await;
            let duplicate = super::skills_plugin::client::request(
                &mut peer,
                "import-source",
                json!({"sourcePath":import_file,"grant":grant}),
            )
            .await;
            assert_eq!(duplicate["reason"], "already_exists", "{duplicate}");
            let invalid = fixture.workspace.join("invalid.md");
            std::fs::write(&invalid, "not a Skill").unwrap();
            let rejected = super::skills_plugin::client::request(
                &mut peer,
                "import-source",
                json!({"sourcePath":invalid,"grant":grant}),
            )
            .await;
            assert_eq!(rejected["reason"], "invalid_skill", "{rejected}");
            assert!(!home.join(".maka/skill-sources/invalid").exists());
            for (base, id, reference) in [
                (".maka", "user-review", "user:maka:user-review"),
                (".agents", "agent-review", "user:agents:agent-review"),
            ] {
                let directory = home.join(base).join("skills").join(id);
                let resolved = super::skills_plugin::client::workspace(
                    &mut peer,
                    &context["workspace"]["path"],
                    json!({
                        "kind":"resolve_path","ref":reference, "target":"file"
                    }),
                )
                .await;
                assert_eq!(resolved["kind"], "resolved", "{resolved}");
                let path = std::path::Path::new(resolved["path"].as_str().unwrap());
                assert_eq!(
                    path.canonicalize().unwrap(),
                    directory.join("SKILL.md").canonicalize().unwrap()
                );
                let basis = catalog(&mut peer, &context, "governance").await;
                let removed = super::skills_plugin::client::request(&mut peer, "user-request", json!({
                    "workspace":{"workspace":context["workspace"],"sandboxMode":"workspace-write","collaborationMode":"agent"},
                    "request":{"kind":"mutate","expectedRevision":basis["revision"],"grant":grant,
                        "mutation":{"kind":"delete","ref":reference}}
                })).await;
                assert_eq!(removed["kind"], "committed", "{removed}");
                assert!(!directory.exists());
                let missing = super::skills_plugin::client::workspace(
                    &mut peer,
                    &context["workspace"]["path"],
                    json!({
                        "kind":"resolve_path","ref":reference, "target":"directory"
                    }),
                )
                .await;
                assert_eq!(missing["reason"], "missing", "{missing}");
            }
            let bundled = catalog(&mut peer, &context, "bundled").await;
            let result = super::skills_plugin::client::workspace(
                &mut peer,
                &context["workspace"]["path"],
                json!({
                    "kind":"mutate","expectedRevision":bundled["revision"],
                    "mutation":{"kind":"install","sourceType":"bundled","sourceId":"computer-use"}
                }),
            )
            .await;
            assert_eq!(result["entry"]["sourceType"], "bundled", "{result}");
            assert_eq!(result["entry"]["manageable"], true);
            let starter = mutate(&mut peer, &context, json!({"kind":"create_starter"})).await;
            assert_eq!(starter["kind"], "committed", "{starter}");
            let again = mutate(&mut peer, &context, json!({"kind":"create_starter"})).await;
            assert_eq!(again["kind"], "unchanged", "{again}");
            assert_eq!(again["entry"]["ref"], starter["entry"]["ref"]);
            terminal.install(&mut peer, &installed, &original).await;
            std::fs::write(installed.join("notes.txt"), "keep my resource").unwrap();
            std::fs::write(installed.join("SKILL.md"), &local).unwrap();
            std::fs::write(source.join("SKILL.md"), &updated).unwrap();
            let auto = mutate(
                &mut peer,
                &context,
                json!({
                    "kind":"update_managed","ref":"workspace:legacy:review","force":false,
                    "expectedCurrentSha256":null,"expectedSourceSha256":null
                }),
            )
            .await;
            assert_eq!(auto["reason"], "local_modified", "{auto}");
            terminal
                .update(&mut peer, &source, &installed, &updated, &local)
                .await;
        } else {
            let page = catalog(&mut peer, &context, "governance").await;
            let review = page["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["ref"] == "workspace:legacy:review")
                .unwrap();
            assert_eq!(review["managedUpdateStatus"], "up_to_date");
            terminal.delete(&mut peer, &installed, &source).await;
            terminal.recover(&mut peer, &approved).await;
            assert!(
                !installed.exists(),
                "original install receipt never reinstalls a deleted skill"
            );
        }
        assert!(!root.join("skill-transactions").exists());
        assert!(
            !fixture.workspace.join(".maka/skills").exists(),
            "installation is profile-private"
        );
        assert_eq!(
            std::fs::read_to_string(&import_file).unwrap(),
            original,
            "managed updates do not synchronize the import file"
        );
        for journal in [
            ".maka/.skills-publication",
            ".agents/.skills-publication",
            ".maka/.skill-sources-publication",
        ] {
            let publications = std::fs::read_dir(home.join(journal))
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .collect::<Vec<_>>();
            assert_eq!(
                publications.len(),
                1,
                "each Host owns its recovery namespace"
            );
            assert_eq!(
                std::fs::read_dir(publications[0].join("transactions"))
                    .unwrap()
                    .count(),
                0
            );
        }
        assert_eq!(
            std::fs::read_dir(namespace.join("transactions"))
                .unwrap()
                .count(),
            0
        );
        assert!(
            !home.join(".maka-workspace.json").exists(),
            "file consent must not initialize an execution workspace"
        );
        if !reopened {
            let journal = std::fs::read_dir(home.join(".maka/.skill-sources-publication"))
                .unwrap()
                .next()
                .unwrap()
                .unwrap()
                .path()
                .join("transactions");
            let digest = content_digest(b"interrupted collection");
            let pending = journal.join(format!("gc-{}-{}", uuid::Uuid::new_v4(), &digest[7..]));
            std::fs::create_dir(&pending).unwrap();
            std::fs::write(pending.join("proof"), b"accepted publication").unwrap();
            pending_recovery = Some(pending);
            super::skills_plugin::client::authorization(
                &mut peer,
                json!({"kind":"revoke","id":approved}),
            )
            .await;
            disabled(&mut peer, true).await;
        }
        peer.close().await;
        drop(cleanup);
        tokio::time::timeout(Duration::from_secs(10), server)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
}

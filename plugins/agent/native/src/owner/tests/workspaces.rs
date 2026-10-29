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
use maka_fs_tools::workspace::MARKER_FILE;
use maka_host_runtime::DirectoryRootSpec;

#[tokio::test]
async fn concurrent_sessions_share_the_same_available_project() {
    let fixture = Fixture::new("http://127.0.0.1:1/v1", None).await;
    let sessions =
        futures_util::future::join_all((0..16).map(|_| fixture.create("Concurrent"))).await;
    let mut projects = std::collections::BTreeSet::new();
    let mut identity = None;
    for id in &sessions {
        let session = fixture.owner.session(id).await.unwrap();
        projects.insert(session.configuration.workspace.project_id);
        let current = session.configuration.workspace.identity;
        match &identity {
            Some(first) => assert_eq!(&current, first),
            None => identity = Some(current),
        }
    }
    assert_eq!(
        sessions
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        16
    );
    assert_eq!(projects.len(), 1);
    assert!(!projects.contains(&None));
    fixture.app.shutdown().await.unwrap();
    fixture.config.shutdown().await.unwrap();
}

#[tokio::test]
async fn creation_waiting_for_session_allows_other_sessions_and_is_rejected_by_close() {
    use futures_util::poll;

    let fixture = Fixture::new("http://127.0.0.1:1/v1", None).await;
    let client = fixture.app.client();
    let input = fixture.create_input("Blocked").await;
    let prepared = client
        .prepare_mutation(
            fixture.binding(2).await,
            "create".into(),
            input.clone(),
            scope(&fixture.issuer, true),
            Uuid::new_v4(),
            Attachments::new().into(),
        )
        .await
        .unwrap();
    let session = fixture.owner.operation_id(prepared.reference());
    let gate = fixture.owner.runs.session(&session).await;
    let scope = scope(&fixture.issuer, true);
    let mut blocked = Box::pin(fixture.owner.create_inner(
        serde_json::from_value(input).unwrap(),
        prepared.reference(),
        &scope,
    ));
    assert!(poll!(blocked.as_mut()).is_pending());

    let other = tokio::time::timeout(Duration::from_secs(10), fixture.create("Independent"))
        .await
        .expect("another Session can be created while the first waits");
    assert_ne!(other, session);
    assert!(poll!(blocked.as_mut()).is_pending());
    assert!(fixture.owner.prepare_retirement().is_none());

    let mut close = fixture.owner.close();
    assert!(poll!(close.as_mut()).is_pending());
    drop(gate);
    // Waiting for Session ordering has not admitted workspace or SQL work.
    let (created, closed) = tokio::join!(blocked, close);
    assert!(matches!(
        created.unwrap(),
        Created::Rejected {
            reason: Rejection::Closed
        }
    ));
    assert!(
        fixture
            .store
            .get_session::<Value>(&session)
            .await
            .unwrap()
            .is_none()
    );
    drop(prepared);
    closed.unwrap();
    fixture.app.shutdown().await.unwrap();
    fixture.config.shutdown().await.unwrap();
}

async fn publish(fixture: &mut Fixture, roots: Vec<DirectoryRootSpec>) {
    let policy = Arc::new(Grant(fixture.issuer.clone(), None));
    publish_with_policy(fixture, roots, policy).await;
}

pub(super) async fn publish_with_policy(
    fixture: &mut Fixture,
    roots: Vec<DirectoryRootSpec>,
    policy: Arc<dyn Policy>,
) {
    let source = fixture.app.source().unwrap().clone();
    fixture.app.shutdown().await.unwrap();
    let mut configuration = fixture.owner.settings.clone();
    configuration.workspace_roots = roots;
    let (input, packages) = input(&configuration);
    fixture
        .store
        .commit_application(source.deployment, source.revision, input, vec![], packages)
        .await
        .unwrap();
    let mut native = NativeRegistry::default();
    maka_settings_native::provide(&mut native, crate::owner::tests::bundled_catalog()).unwrap();
    crate::owner::tests::provide_all(&mut native).unwrap();
    fixture.app = Application::start_from_store(
        fixture.store.clone(),
        source.deployment,
        native,
        fixture.issuer.clone(),
        policy,
        Some(maka_host_js::factory(Default::default())),
    )
    .await
    .unwrap();
    fixture.app.ready().await.unwrap();
}

#[tokio::test]
async fn published_directories_are_readonly_paged_and_create_only_observed_workspaces() {
    let fixture = Fixture::new("http://127.0.0.1:1/v1", None).await;
    for index in 0..36 {
        std::fs::create_dir(fixture.workspace.join(format!("dir-{index:02}"))).unwrap();
    }
    let roots = fixture
        .query("directories", json!({"kind":"roots"}))
        .await
        .unwrap();
    assert_eq!(roots["roots"].as_array().unwrap().len(), 2);
    assert!(!fixture.workspace.join(MARKER_FILE).exists());
    assert!(!fixture.root.join(MARKER_FILE).exists());
    let selection = roots["roots"][0]["selection"].clone();
    let page = fixture
        .query(
            "directories",
            json!({"kind":"children","selection":selection,"after":null}),
        )
        .await
        .unwrap();
    assert_eq!(page["children"].as_array().unwrap().len(), 32);
    assert_eq!(page["after"], "dir-31");
    let tail = fixture
        .query(
            "directories",
            json!({"kind":"children","selection":selection,"after":page["after"]}),
        )
        .await
        .unwrap();
    assert_eq!(tail["children"].as_array().unwrap().len(), 4);
    assert!(tail["after"].is_null());
    for (children, indices) in [(&page["children"], 0..32), (&tail["children"], 32..36)] {
        let expected: Vec<_> = indices.map(|index| {
            let name = format!("dir-{index:02}");
            let (path, identity) = maka_fs_tools::directory::capture(&fixture.workspace.join(&name)).unwrap();
            json!({"name":name,"path":maka_fs_tools::workspace::project::host_path(&path).unwrap(),
                "selection":{"rootId":"root-1","segments":[name],"directoryIdentity":identity}})
        }).collect();
        assert_eq!(*children, json!(expected));
    }
    assert!(!fixture.workspace.join(MARKER_FILE).exists());
    for (field, value) in [
        ("rootId", json!("unknown")),
        ("segments", json!([".."])),
        (
            "directoryIdentity",
            json!(format!("sha256:{}", "0".repeat(64))),
        ),
    ] {
        let mut invalid = selection.clone();
        invalid[field] = value;
        let result = fixture.mutation(2, "create", json!({"title":"Rejected","labels":[],"workspace":{"kind":"directory","selection":invalid}}), Uuid::new_v4()).await.unwrap();
        assert_eq!(
            result,
            json!({"kind":"rejected","reason":"workspace_unavailable"})
        );
    }
    let child = &page["children"][3];
    let result = fixture.mutation(2, "create", json!({"title":"Selected child","labels":["research"],"workspace":{"kind":"directory","selection":child["selection"]}}), Uuid::new_v4()).await.unwrap();
    assert_eq!(result["kind"], "created");
    let session = &result["session"];
    assert_eq!(session["workspace"]["path"], child["path"]);
    assert_eq!(
        session["workspace"]["directoryIdentity"],
        child["selection"]["directoryIdentity"]
    );
    assert_eq!(session["labels"], json!(["research"]));
    assert!(fixture.workspace.join("dir-03").join(MARKER_FILE).exists());
    assert!(!fixture.workspace.join(MARKER_FILE).exists());
    let reused = fixture.mutation(2, "create", json!({"title":"Reused workspace","labels":[],"workspace":{"kind":"session","sessionId":session["id"]}}), Uuid::new_v4()).await.unwrap();
    assert_eq!(reused["session"]["workspace"], session["workspace"]);
    assert_ne!(reused["session"]["id"], session["id"]);
    for index in 0..4097 {
        std::fs::write(fixture.workspace.join(format!("file-{index}")), []).unwrap();
    }
    let completed = async {
        let repeated = fixture
            .query(
                "directories",
                json!({"kind":"children","selection":selection,"after":null})
            )
            .await?;
        let remaining = fixture.query("directories", json!({"kind":"children","selection":selection,"after":repeated["after"]})).await?;
        let query_markers: Vec<_> = (0..36).map(|index| fixture.workspace.join(format!("dir-{index:02}")).join(MARKER_FILE).exists()).collect();
        let created = fixture.mutation(2, "create", json!({"title":"Paged child","labels":[],"workspace":{"kind":"directory","selection":remaining["children"][0]["selection"]}}), Uuid::new_v4()).await?;
        Ok::<_, String>((repeated, remaining, query_markers, created))
    }.await;
    fixture.drained().await;
    let app_shutdown = fixture.app.shutdown().await;
    let config_shutdown = fixture.config.shutdown().await;
    app_shutdown.unwrap();
    config_shutdown.unwrap();
    let (repeated, remaining, query_markers, created) =
        completed.expect("ordinary files must not prevent completed child directory pages");
    assert_eq!(repeated, page);
    assert_eq!(remaining, tail);
    assert_eq!(
        query_markers,
        (0..36).map(|index| index == 3).collect::<Vec<_>>()
    );
    assert_eq!(created["kind"], "created");
    assert_eq!(
        created["session"]["workspace"]["path"],
        tail["children"][0]["path"]
    );
    assert_eq!(
        created["session"]["workspace"]["directoryIdentity"],
        tail["children"][0]["selection"]["directoryIdentity"]
    );
    assert_eq!(
        created["session"]["workspace"]["identity"],
        json!(maka_fs_tools::workspace::read_identity(&fixture.workspace.join("dir-32")).unwrap())
    );
    assert!(!fixture.workspace.join(MARKER_FILE).exists());
    for index in 0..36 {
        assert_eq!(
            fixture
                .workspace
                .join(format!("dir-{index:02}"))
                .join(MARKER_FILE)
                .exists(),
            index == 3 || index == 32
        );
    }
    for index in 0..4097 {
        let path = fixture.workspace.join(format!("file-{index}"));
        assert!(std::fs::metadata(&path).unwrap().is_file());
        assert_eq!(std::fs::read(path).unwrap(), Vec::<u8>::new());
    }
}

#[tokio::test]
async fn published_directory_depth_65_creates_only_the_observed_leaf() {
    use futures_util::FutureExt;
    use std::panic::AssertUnwindSafe;

    let fixture = Fixture::new("http://127.0.0.1:1/v1", None).await;
    let completed = AssertUnwindSafe(async {
        let mut physical = vec![
            maka_fs_tools::directory::capture(&fixture.workspace)
                .map_err(|error| error.to_string())?,
        ];
        for _ in 0..65 {
            let path = physical.last().unwrap().0.join("d");
            std::fs::create_dir(&path).map_err(|error| error.to_string())?;
            physical
                .push(maka_fs_tools::directory::capture(&path).map_err(|error| error.to_string())?);
        }
        let leaf = maka_fs_tools::workspace::project::host_path(&physical[65].0)
            .map_err(|error| error.to_string())?;
        if leaf.len() > 4096 {
            return Err("physical depth-65 fixture exceeds the Host path bound".to_owned());
        }
        let base = maka_fs_tools::workspace::project::host_path(&physical[0].0)
            .map_err(|error| error.to_string())?;
        let roots = fixture
            .query("directories", json!({"kind":"roots"}))
            .await?;
        let root = roots["roots"]
            .as_array()
            .ok_or("missing published roots")?
            .iter()
            .find(|root| root["path"] == base)
            .cloned()
            .ok_or("physical workspace root was not published")?;
        let mut selection = root["selection"].clone();
        let mut directory = root.clone();
        let mut pages = Vec::new();
        for depth in 0..65 {
            let input = json!({"kind":"children","selection":selection,"after":null});
            let path = maka_fs_tools::workspace::project::host_path(&physical[depth + 1].0)
                .map_err(|error| error.to_string())?;
            let child = json!({"name":"d","path":path,
                "selection":{"rootId":"root-1","segments":vec!["d"; depth + 1],
                "directoryIdentity":physical[depth + 1].1}});
            let expected = json!({"kind":"children","directory":directory,
                "children":[child],"after":null});
            if depth == 64 {
                eprintln!(
                    "depth65 base={:?} leaf={leaf} query_bytes={} expected_page_bytes={}",
                    physical[0].0,
                    serde_json::to_vec(&input).unwrap().len(),
                    serde_json::to_vec(&expected).unwrap().len()
                );
            }
            let page = fixture
                .query("directories", input.clone())
                .await
                .map_err(|error| format!("published children at depth {depth}: {error}"))?;
            selection = page["children"]
                .as_array()
                .and_then(|children| children.first())
                .and_then(|child| child.get("selection"))
                .cloned()
                .ok_or_else(|| format!("depth {depth} did not return an actual child selection"))?;
            pages.push((input, page, expected));
            directory = child;
        }
        let query_markers: Vec<_> = physical
            .iter()
            .map(|(path, _)| path.join(MARKER_FILE).exists())
            .collect();
        let create_input = json!({"title":"Deep published leaf","labels":[],
            "workspace":{"kind":"directory","selection":selection}});
        let created = fixture
            .mutation(2, "create", create_input.clone(), Uuid::new_v4())
            .await?;
        Ok::<_, String>((physical, root, pages, query_markers, create_input, created))
    })
    .catch_unwind()
    .await;
    fixture.drained().await;
    let app_shutdown = fixture.app.shutdown().await;
    let config_shutdown = fixture.config.shutdown().await;
    app_shutdown.unwrap();
    config_shutdown.unwrap();
    let completed = completed.unwrap_or_else(|panic| std::panic::resume_unwind(panic));
    let (physical, root, pages, query_markers, create_input, created) = completed
        .expect("public browsing must return the actual depth-65 selection before creating it");
    assert_eq!(
        root["selection"],
        json!({"rootId":"root-1","segments":[],
        "directoryIdentity":physical[0].1})
    );
    assert_eq!(
        maka_fs_tools::workspace::project::host_path(&physical[65].0)
            .unwrap()
            .len(),
        maka_fs_tools::workspace::project::host_path(&physical[0].0)
            .unwrap()
            .len()
            + 130
    );
    for (depth, (input, page, expected)) in pages.iter().enumerate() {
        assert_eq!(
            page, expected,
            "wrong published page at parent depth {depth}"
        );
        assert!(serde_json::to_vec(input).unwrap().len() < 48 * 1024);
        assert!(serde_json::to_vec(page).unwrap().len() < 48 * 1024);
    }
    assert!(
        query_markers.iter().all(|exists| !exists),
        "browsing created a marker"
    );
    assert!(serde_json::to_vec(&create_input).unwrap().len() < 48 * 1024);
    assert_eq!(created["kind"], "created");
    assert_eq!(
        created["session"]["workspace"]["path"],
        json!(maka_fs_tools::workspace::project::host_path(&physical[65].0).unwrap())
    );
    assert_eq!(
        created["session"]["workspace"]["directoryIdentity"],
        json!(physical[65].1)
    );
    assert_eq!(
        created["session"]["workspace"]["identity"],
        json!(maka_fs_tools::workspace::read_identity(&physical[65].0).unwrap())
    );
    for (depth, (path, identity)) in physical.iter().enumerate() {
        assert_eq!(
            maka_fs_tools::directory::capture(path).unwrap(),
            (path.clone(), identity.clone())
        );
        assert_eq!(
            path.join(MARKER_FILE).exists(),
            depth == 65,
            "only the selected leaf may have a workspace marker"
        );
    }
    assert!(!fixture.root.join(MARKER_FILE).exists());
}

#[tokio::test]
async fn malformed_existing_marker_is_a_recorded_refusal_without_repair() {
    let fixture = Fixture::new("http://127.0.0.1:1/v1", None).await;
    let input = fixture.create_input("Malformed workspace").await;
    let marker = fixture.workspace.join(MARKER_FILE);
    std::fs::write(&marker, b"{broken").unwrap();
    let operation = Uuid::new_v4();
    let refused = fixture
        .mutation(2, "create", input.clone(), operation)
        .await
        .unwrap();
    assert_eq!(
        refused,
        json!({"kind":"rejected","reason":"workspace_unavailable"})
    );
    assert_eq!(
        fixture
            .mutation(2, "create", input, operation)
            .await
            .unwrap(),
        refused
    );
    assert_eq!(std::fs::read(&marker).unwrap(), b"{broken");
    assert!(
        fixture
            .query("list", json!({"filter":"all","position":{"kind":"start"}}))
            .await
            .unwrap()["sessions"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(!fixture.root.join(MARKER_FILE).exists());
    fixture.app.shutdown().await.unwrap();
    fixture.config.shutdown().await.unwrap();
}

#[tokio::test]
async fn original_uppercase_marker_and_two_workspaces_reach_exact_execution_configuration() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                request(&mut socket).await;
                response(&mut socket).await;
            }
        });
        let fixture = Fixture::new(&base, None).await;
        let uppercase = "A1234567-B89A-4CDE-8F01-23456789ABCD";
        let marker = fixture.workspace.join(MARKER_FILE);
        let bytes = serde_json::to_vec(&json!({"schemaVersion":1,"workspaceId":uppercase})).unwrap();
        std::fs::write(&marker, &bytes).unwrap();
        let first = fixture.create("Original uppercase").await;
        let roots = fixture.query("directories", json!({"kind":"roots"})).await.unwrap();
        let second = fixture.mutation(2, "create", json!({"title":"Other workspace","labels":[],"workspace":{"kind":"directory","selection":roots["roots"][1]["selection"]}}), Uuid::new_v4()).await.unwrap()["session"]["id"].as_str().unwrap().to_owned();
        for id in [&first, &second] {
            fixture.send(id).await.unwrap();
            fixture.drained().await;
        }
        server.await.unwrap();
        let observed = fixture.query("observe", json!({"sessionId":first})).await.unwrap();
        assert_eq!(observed["session"]["workspace"]["identity"], format!("workspace:v1:{uppercase}"));
        assert_eq!(std::fs::read(&marker).unwrap(), bytes);
        let listed = fixture.query("list", json!({"filter":"all","position":{"kind":"start"}})).await.unwrap();
        assert_eq!(listed["sessions"].as_array().unwrap().len(), 2);
        let mut events = Vec::new();
        for id in [&first, &second] {
            events.extend(fixture.prefix(id, 128, 512 * 1024).await.events);
        }
        let mut configurations = BTreeMap::new();
        for stored in events {
            if let maka_agent_facts::event::Fact::InvocationOpened { configuration: Some(configuration), .. } = stored.event.fact {
                configurations.insert(stored.event.invocation.session_id, configuration);
            }
        }
        assert_eq!(configurations.len(), 2);
        for id in [&first, &second] {
            let session = fixture.owner.session(id).await.unwrap();
            let configuration = &configurations[id];
            assert_eq!(configuration.cwd, session.configuration.workspace.path);
            assert_eq!(configuration.workspace_identity, Some(session.configuration.workspace.identity));
            assert_eq!(configuration.workspace_origin, WorkspaceOrigin::Selected);
            assert_eq!(configuration.workspace_binding, Some(session.configuration.binding));
            assert_ne!(std::path::Path::new(&configuration.cwd), fixture.root.canonicalize().unwrap());
        }
        assert_ne!(configurations[&first].cwd, configurations[&second].cwd);
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn metadata_cas_replay_and_noop_preserve_active_run_workspace_and_activity() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let entered = Arc::new(Semaphore::new(0));
        let release = Arc::new(Semaphore::new(0));
        let (accepted, finish) = (entered.clone(), release.clone());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            request(&mut socket).await;
            accepted.add_permits(1);
            finish.acquire().await.unwrap().forget();
            response(&mut socket).await;
        });
        let fixture = Fixture::new(&base, None).await;
        let id = fixture.create("Original title").await;
        let started = fixture.send(&id).await.unwrap();
        entered.acquire().await.unwrap().forget();
        let before = fixture.query("observe", json!({"sessionId":id})).await.unwrap();
        let original_catalog = fixture.query("list", json!({"filter":"all","position":{"kind":"start"}})).await.unwrap();
        let input = json!({"sessionId":id,"expectedRevision":before["session"]["revision"],"title":"Research","labels":["orchid","rust"]});
        let operation = Uuid::new_v4();
        let updated = fixture.mutation(2, "metadata", input.clone(), operation).await.unwrap();
        assert_eq!(updated["kind"], "committed");
        assert_eq!(updated["session"]["title"], "Research");
        assert_eq!(updated["session"]["labels"], json!(["orchid","rust"]));
        assert_eq!(updated["session"]["workspace"], before["session"]["workspace"]);
        assert_eq!(updated["session"]["updatedAt"], before["session"]["updatedAt"]);
        assert_eq!(fixture.mutation(2, "metadata", input.clone(), operation).await.unwrap(), updated);
        let conflict = fixture.mutation(2, "metadata", input, Uuid::new_v4()).await.unwrap();
        assert_eq!(conflict, json!({"kind":"revision_conflict","expected":before["session"]["revision"],"actual":updated["session"]["revision"]}));
        let noop = fixture.mutation(2, "metadata", json!({"sessionId":id,"expectedRevision":updated["session"]["revision"],"title":"Research","labels":["orchid","rust"]}), Uuid::new_v4()).await.unwrap();
        assert_eq!(noop, updated);
        let invalid = fixture.mutation(2, "metadata", json!({"sessionId":id,"expectedRevision":updated["session"]["revision"],"title":" ","labels":[]}), Uuid::new_v4()).await.unwrap();
        assert_eq!(invalid, json!({"kind":"rejected","reason":"title_invalid"}));
        let foreign = fixture.mutation(2, "metadata", json!({"sessionId":"foreign","expectedRevision":1,"title":"Other","labels":[]}), Uuid::new_v4()).await.unwrap();
        assert_eq!(foreign, json!({"kind":"rejected","reason":"session_unavailable"}));
        let after = fixture.query("observe", json!({"sessionId":id})).await.unwrap();
        assert_eq!(after["through"], before["through"]);
        assert_eq!(after["run"]["invocationId"], started["invocationId"]);
        assert!(fixture.query("list", json!({"filter":"all","position":{"kind":"after","revision":original_catalog["revision"],"cursor":id}})).await.is_err());
        release.add_permits(1);
        server.await.unwrap();
        fixture.drained().await;
        let after = fixture.query("observe", json!({"sessionId":id})).await.unwrap();
        assert!(after["run"].is_null());
        assert_eq!(after["session"]["title"], "Research");
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn full_session_projection_budget_preserves_forward_and_reverse_catalog_boundaries() {
    let fixture = Fixture::new("http://127.0.0.1:1/v1", None).await;
    for index in 0..14 {
        let mut input = fixture.create_input(&format!("Session {index}")).await;
        input["labels"] = json!(vec!["\"".repeat(128); 32]);
        let result = fixture
            .mutation(2, "create", input, Uuid::new_v4())
            .await
            .unwrap();
        assert_eq!(result["kind"], "created");
    }
    let expected = fixture
        .store
        .scoped_sessions::<StoredSessionConfiguration>(
            maka_event_log::sessions::CatalogScope::IdPrefix(fixture.owner.prefix.clone()),
            None,
            maka_event_log::sessions::SessionPosition::Start,
            maka_event_log::sessions::CatalogFilter {
                archived_only: false,
                include_archived: false,
                pending_only: false,
            },
        )
        .await
        .unwrap()
        .sessions
        .into_iter()
        .map(|session| session.id)
        .collect::<Vec<_>>();
    assert_eq!(expected.len(), 14);
    let mut page = fixture
        .query("list", json!({"filter":"all","position":{"kind":"start"}}))
        .await
        .unwrap();
    assert!(page["sessions"].as_array().unwrap().len() < 14);
    let revision = page["revision"].clone();
    let mut forward = Vec::new();
    loop {
        assert!(serde_json::to_vec(&page).unwrap().len() <= workspace::PAGE_BYTES);
        let sessions = page["sessions"].as_array().unwrap();
        forward.extend(
            sessions
                .iter()
                .map(|s| s["id"].as_str().unwrap().to_owned()),
        );
        if page["after"].is_null() {
            break;
        }
        assert_eq!(page["after"], sessions.last().unwrap()["id"]);
        page = fixture
            .query(
                "list",
                json!({"filter":"all","position":{"kind":"after","revision":revision,"cursor":page["after"]}}),
            )
            .await
            .unwrap();
    }
    assert_eq!(forward, expected);
    let mut reverse = page["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["id"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    while !page["before"].is_null() {
        assert_eq!(page["before"], page["sessions"][0]["id"]);
        page = fixture
            .query(
                "list",
                json!({"filter":"all","position":{"kind":"before","revision":revision,"cursor":page["before"]}}),
            )
            .await
            .unwrap();
        assert!(serde_json::to_vec(&page).unwrap().len() <= workspace::PAGE_BYTES);
        let mut rows = page["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["id"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        rows.extend(reverse);
        reverse = rows;
    }
    assert_eq!(reverse, expected);
    fixture.app.shutdown().await.unwrap();
    fixture.config.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn original_directory_moved_into_managed_worktrees_cannot_be_reborrowed_by_symlink() {
    let mut fixture = Fixture::new("http://127.0.0.1:1/v1", None).await;
    let root = fixture._dir.path().canonicalize().unwrap();
    publish(
        &mut fixture,
        vec![DirectoryRootSpec {
            label: "Parent".into(),
            path: root,
        }],
    )
    .await;
    let roots = fixture
        .query("directories", json!({"kind":"roots"}))
        .await
        .unwrap();
    let children = fixture
        .query(
            "directories",
            json!({"kind":"children","selection":roots["roots"][0]["selection"],"after":null}),
        )
        .await
        .unwrap();
    let selected = children["children"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["name"] == "workspace")
        .unwrap();
    let created = fixture.mutation(2, "create", json!({"title":"Original object","labels":[],"workspace":{"kind":"directory","selection":selected["selection"]}}), Uuid::new_v4()).await.unwrap();
    let id = created["session"]["id"].as_str().unwrap();
    let destination = fixture.root.join("subagent-worktrees/borrowed");
    std::fs::create_dir_all(destination.parent().unwrap()).unwrap();
    std::fs::rename(&fixture.workspace, &destination).unwrap();
    std::os::unix::fs::symlink(&destination, &fixture.workspace).unwrap();
    assert!(
        fixture
            .send(id)
            .await
            .unwrap_err()
            .contains("agent_workspace_unavailable")
    );
    assert!(
        fixture
            .session(id)
            .await
            .session_projection::<StoredSessionConfiguration>(id)
            .await
            .unwrap()
            .unwrap()
            .root_turn
            .is_none()
    );
    let reused = fixture.mutation(2, "create", json!({"title":"Forbidden reuse","labels":[],"workspace":{"kind":"session","sessionId":id}}), Uuid::new_v4()).await.unwrap();
    assert_eq!(
        reused,
        json!({"kind":"rejected","reason":"workspace_unavailable"})
    );
    fixture.app.shutdown().await.unwrap();
    fixture.config.shutdown().await.unwrap();
}

#[tokio::test]
async fn replaced_directory_marker_and_removed_publication_refuse_before_message_admission() {
    let mut fixture = Fixture::new("http://127.0.0.1:1/v1", None).await;
    let input = fixture.create_input("Observed directory").await;
    let old = fixture.workspace.with_file_name("original-workspace");
    std::fs::rename(&fixture.workspace, &old).unwrap();
    std::fs::create_dir(&fixture.workspace).unwrap();
    let stale = fixture
        .mutation(2, "create", input, Uuid::new_v4())
        .await
        .unwrap();
    assert_eq!(
        stale,
        json!({"kind":"rejected","reason":"workspace_unavailable"})
    );
    assert!(!old.join(MARKER_FILE).exists());
    assert!(!fixture.workspace.join(MARKER_FILE).exists());
    std::fs::remove_dir(&fixture.workspace).unwrap();
    std::fs::rename(&old, &fixture.workspace).unwrap();
    let id = fixture.create("Original marker").await;
    let marker = fixture.workspace.join(MARKER_FILE);
    let original = std::fs::read(&marker).unwrap();
    std::fs::write(
        &marker,
        serde_json::to_vec(&json!({"schemaVersion":1,"workspaceId":Uuid::new_v4().to_string()}))
            .unwrap(),
    )
    .unwrap();
    assert!(
        fixture
            .send(&id)
            .await
            .unwrap_err()
            .contains("agent_workspace_unavailable")
    );
    assert!(
        fixture
            .session(&id)
            .await
            .session_projection::<StoredSessionConfiguration>(&id)
            .await
            .unwrap()
            .unwrap()
            .root_turn
            .is_none()
    );
    std::fs::write(&marker, &original).unwrap();
    let other = fixture.owner.settings.workspace_roots[1].clone();
    publish(&mut fixture, vec![other]).await;
    assert!(
        fixture
            .send(&id)
            .await
            .unwrap_err()
            .contains("agent_workspace_unavailable")
    );
    assert!(
        fixture
            .session(&id)
            .await
            .session_projection::<StoredSessionConfiguration>(&id)
            .await
            .unwrap()
            .unwrap()
            .root_turn
            .is_none()
    );
    assert_eq!(std::fs::read(&marker).unwrap(), original);
    fixture.app.shutdown().await.unwrap();
    fixture.config.shutdown().await.unwrap();
}

#[tokio::test]
async fn removing_all_published_directories_keeps_the_service_available_without_workspace_authority()
 {
    let mut fixture = Fixture::new("http://127.0.0.1:1/v1", None).await;
    let original = fixture
        .query("directories", json!({"kind":"roots"}))
        .await
        .unwrap();
    let selection = original["roots"][0]["selection"].clone();
    publish(&mut fixture, vec![]).await;
    assert_eq!(
        fixture
            .query("directories", json!({"kind":"roots"}))
            .await
            .unwrap()["roots"],
        json!([])
    );
    assert!(
        fixture
            .query(
                "directories",
                json!({"kind":"children","selection":selection,"after":null})
            )
            .await
            .is_err()
    );
    fixture.app.shutdown().await.unwrap();
    fixture.config.shutdown().await.unwrap();
}

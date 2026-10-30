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

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

async fn projects(fixture: &Fixture) -> Value {
    fixture
        .query("projects", json!({"kind":"list","cursor":null}))
        .await
        .unwrap()
}
async fn change(fixture: &Fixture, value: Value) -> Value {
    fixture
        .mutation(2, "project", value, Uuid::new_v4())
        .await
        .unwrap()
}

#[tokio::test]
async fn projects_register_create_rename_archive_restore_and_relocate_original_sessions() {
    let fixture = Fixture::new("http://127.0.0.1:1/v1", None).await;
    let roots = fixture
        .query("directories", json!({"kind":"roots"}))
        .await
        .unwrap();
    let source = roots["roots"][0]["selection"].clone();
    let destination = roots["roots"][1]["selection"].clone();
    assert_eq!(projects(&fixture).await["projects"], json!([]));
    let preview = fixture
        .query("projects", json!({"kind":"directory","selection":source}))
        .await
        .unwrap();
    assert!(preview["location"]["project"].is_null());
    assert!(
        !fixture.workspace.join(MARKER_FILE).exists(),
        "queries do not create workspace markers"
    );
    let registered = change(
        &fixture,
        json!({"kind":"register","selection":source,"expected":null}),
    )
    .await;
    assert_eq!(registered["kind"], "committed");
    assert!(!fixture.workspace.join(MARKER_FILE).exists());
    let selected = registered["project"]["reference"].clone();
    let created = fixture.mutation(2,"create",json!({"title":"Project conversation","labels":[],"workspace":{"kind":"project","project":selected,"selection":source}}),Uuid::new_v4()).await.unwrap();
    assert_eq!(created["kind"], "created");
    let session = created["session"]["id"].as_str().unwrap();
    assert_eq!(created["session"]["workspace"]["projectId"], selected["id"]);
    assert!(fixture.workspace.join(MARKER_FILE).exists());
    let current = projects(&fixture).await["projects"][0]["reference"].clone();
    let name = format!("Research 项目{}", "完整".repeat(9000));
    let renamed = change(
        &fixture,
        json!({"kind":"rename","project":current,"name":name}),
    )
    .await;
    assert_eq!(
        renamed["project"]["name"],
        format!("Research 项目{}", "完整".repeat(9000))
    );
    let listed = projects(&fixture).await;
    assert_eq!(listed["projects"][0], renamed["project"]);
    let directory = fixture
        .query("projects", json!({"kind":"directory","selection":source}))
        .await
        .unwrap();
    assert_eq!(directory["location"]["project"], renamed["project"]);
    assert_eq!(
        change(&fixture, json!({"kind":"archive","project":current})).await["kind"],
        "changed"
    );
    let archived = change(
        &fixture,
        json!({"kind":"archive","project":renamed["project"]["reference"]}),
    )
    .await;
    assert_eq!(archived["project"]["archived"], true);
    let denied = fixture.mutation(2,"create",json!({"title":"Archived","labels":[],"workspace":{"kind":"project","project":archived["project"]["reference"],"selection":source}}),Uuid::new_v4()).await.unwrap();
    assert_eq!(denied["kind"], "rejected");
    let denied = fixture.mutation(2,"create",json!({"title":"Archived session shortcut","labels":[],"workspace":{"kind":"session","sessionId":session}}),Uuid::new_v4()).await.unwrap();
    assert_eq!(denied["kind"], "rejected");
    let restored = change(
        &fixture,
        json!({"kind":"restore","project":archived["project"]["reference"]}),
    )
    .await;
    assert_eq!(restored["project"]["archived"], false);
    let before = fixture.owner.session(session).await.unwrap();
    let stored_before = fixture
        .session(session)
        .await
        .get_session::<Value>(session)
        .await
        .unwrap()
        .unwrap()
        .configuration;
    let sibling = fixture
        .mutation(
            2,
            "create",
            json!({
                "title": "Shared selection", "labels": [],
                "workspace": {"kind": "session", "sessionId": session}
            }),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
    assert_eq!(
        sibling["session"]["binding"]["id"],
        created["session"]["binding"]["id"]
    );
    fixture
        .store
        .create_session(
            "foreign",
            "foreign",
            &json!({"different":"configuration"}),
            1,
        )
        .await
        .unwrap();
    let relocated = change(&fixture,json!({"kind":"relocate","project":restored["project"]["reference"],"selection":destination,"destination":null})).await;
    assert_eq!(relocated["kind"], "committed");
    assert_eq!(relocated["project"]["reference"]["id"], selected["id"]);
    let after = fixture.owner.session(session).await.unwrap();
    assert_eq!(
        after.configuration.workspace.path,
        roots["roots"][1]["path"].as_str().unwrap()
    );
    assert_eq!(
        after.configuration.boundary_revision,
        before.configuration.boundary_revision + 1
    );
    assert_eq!(after.updated_at, before.updated_at);
    assert_eq!(after.revision, before.revision + 1);
    assert_eq!(
        after.configuration.binding.id,
        before.configuration.binding.id
    );
    assert_eq!(
        after.configuration.binding.permission_epoch,
        before.configuration.binding.permission_epoch + 1
    );
    assert_eq!(
        fixture
            .session(session)
            .await
            .get_session::<Value>(session)
            .await
            .unwrap()
            .unwrap()
            .configuration,
        stored_before,
        "relocation changes the shared binding without rewriting Session metadata"
    );
    let sibling_id = sibling["session"]["id"].as_str().unwrap();
    assert_eq!(
        fixture
            .owner
            .session(sibling_id)
            .await
            .unwrap()
            .configuration
            .workspace,
        after.configuration.workspace
    );
    assert_eq!(
        after.configuration.permissions,
        before.configuration.permissions
    );
    assert_eq!(
        fixture
            .session("foreign")
            .await
            .get_session::<Value>("foreign")
            .await
            .unwrap()
            .unwrap()
            .configuration,
        json!({"different":"configuration"})
    );
    fixture.app.shutdown().await.unwrap();
    fixture.config.shutdown().await.unwrap();
}

#[tokio::test]
async fn projects_are_owner_scoped_and_stale_pages_and_directory_replacements_are_rejected() {
    let fixture = Fixture::new("http://127.0.0.1:1/v1", None).await;
    let hidden = fixture
        .store
        .register_project(
            maka_event_log::projects::ProjectRegistration {
                identity: "another-owner:folder:private".into(),
                name: "Private".into(),
                path: "/private-unpublished".into(),
                is_worktree: false,
            },
            true,
            1,
        )
        .await
        .unwrap();
    assert_eq!(projects(&fixture).await["projects"], json!([]));
    let rejected = change(&fixture,json!({"kind":"rename","project":{"id":hidden.id,"revision":"0".repeat(64)},"name":"Stolen"})).await;
    assert_eq!(rejected["kind"], "unavailable");
    for index in 0..17 {
        std::fs::create_dir(fixture.workspace.join(format!("project-{index:02}"))).unwrap();
    }
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
    for child in children["children"].as_array().unwrap() {
        assert_eq!(
            change(
                &fixture,
                json!({"kind":"register","selection":child["selection"],"expected":null})
            )
            .await["kind"],
            "committed"
        );
    }
    let page = projects(&fixture).await;
    assert_eq!(page["projects"].as_array().unwrap().len(), 16);
    assert!(!page["next"].is_null());
    let last = fixture
        .query("projects", json!({"kind":"list","cursor":page["next"]}))
        .await
        .unwrap();
    assert_eq!(last["projects"].as_array().unwrap().len(), 1);
    change(
        &fixture,
        json!({"kind":"rename","project":page["projects"][0]["reference"],"name":"Changed"}),
    )
    .await;
    assert_eq!(
        fixture
            .query("projects", json!({"kind":"list","cursor":page["next"]}))
            .await
            .unwrap()["kind"],
        "changed"
    );
    let child = &children["children"][0];
    let observed_project = fixture
        .query(
            "projects",
            json!({"kind":"directory","selection":child["selection"]}),
        )
        .await
        .unwrap()["location"]["project"]
        .clone();
    let path = std::path::PathBuf::from(child["path"].as_str().unwrap());
    std::fs::rename(&path, path.with_extension("retired")).unwrap();
    std::fs::create_dir(&path).unwrap();
    let replaced = fixture.mutation(2, "create", json!({"title":"Replaced project", "labels":[], "workspace":{"kind":"project","project":observed_project["reference"],"selection":observed_project["selection"]}}), Uuid::new_v4()).await.unwrap();
    assert_eq!(replaced["kind"], "rejected");
    assert!(!path.join(MARKER_FILE).exists());
    assert_eq!(
        fixture
            .query(
                "projects",
                json!({"kind":"directory","selection":child["selection"]})
            )
            .await
            .unwrap()["kind"],
        "unavailable"
    );
    assert_eq!(
        change(
            &fixture,
            json!({"kind":"register","selection":child["selection"],"expected":null})
        )
        .await["kind"],
        "unavailable"
    );
    fixture.app.shutdown().await.unwrap();
    fixture.config.shutdown().await.unwrap();
}

#[tokio::test]
async fn projects_relocation_rejects_running_and_queued_work_then_merges_without_rewriting_destination_authority()
 {
    tokio::time::timeout(Duration::from_secs(40), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let fixture = Fixture::new(&base, None).await;
        let source_session = fixture.create("Source").await;
        let roots = fixture.query("directories", json!({"kind":"roots"})).await.unwrap();
        let destination = roots["roots"][1]["selection"].clone();
        let target = fixture.mutation(2, "create", json!({"title":"Destination", "labels":[], "workspace":{"kind":"directory","selection":destination}}), Uuid::new_v4()).await.unwrap();
        let target_id = target["session"]["id"].as_str().unwrap();
        let original = fixture.owner.session(&source_session).await.unwrap();
        let target_original = fixture.owner.session(target_id).await.unwrap();
        let project_id = original.configuration.workspace.project_id.unwrap().to_string();
        let catalog = projects(&fixture).await;
        let source = catalog["projects"].as_array().unwrap().iter().find(|p| p["reference"]["id"] == project_id).unwrap()["reference"].clone();
        let preview = fixture.query("projects", json!({"kind":"directory","selection":destination})).await.unwrap();
        let relocation = json!({"kind":"relocate","project":source,"selection":destination,"destination":preview["location"]["project"]["reference"]});
        fixture.send(&source_session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        assert_eq!(fixture.send(&source_session).await.unwrap()["kind"], "queued");
        assert_eq!(change(&fixture, relocation.clone()).await["kind"], "busy");
        assert_eq!(fixture.owner.session(&source_session).await.unwrap().configuration.workspace, original.configuration.workspace);
        assert_eq!(fixture.session(&source_session).await.pending_messages(&source_session).await.unwrap().len(), 1);
        response(&mut socket).await;
        let (mut next, _) = listener.accept().await.unwrap();
        request(&mut next).await;
        assert_eq!(change(&fixture, relocation.clone()).await["kind"], "busy");
        response(&mut next).await;
        fixture.drained().await;
        let source_stored = fixture.session(&source_session).await.get_session::<Value>(&source_session).await.unwrap().unwrap().configuration;
        let target_stored = fixture.session(target_id).await.get_session::<Value>(target_id).await.unwrap().unwrap().configuration;
        let merged = change(&fixture, relocation).await;
        assert_eq!(merged["kind"], "committed");
        assert_eq!(projects(&fixture).await["projects"].as_array().unwrap().len(), 1);
        let moved = fixture.owner.session(&source_session).await.unwrap();
        assert_eq!(moved.configuration.workspace.path, target_original.configuration.workspace.path);
        assert_eq!(moved.configuration.boundary_revision, original.configuration.boundary_revision + 1);
        let retained = fixture.owner.session(target_id).await.unwrap();
        assert_eq!(retained.configuration.workspace.project_id, moved.configuration.workspace.project_id);
        assert_eq!(retained.configuration.workspace.path, target_original.configuration.workspace.path);
        assert_eq!(retained.configuration.workspace.identity, target_original.configuration.workspace.identity);
        assert_eq!(retained.configuration.boundary_revision, target_original.configuration.boundary_revision);
        assert_eq!(retained.updated_at, target_original.updated_at);
        assert_eq!(retained.configuration.binding, target_original.configuration.binding);
        assert_eq!(retained.revision, target_original.revision + 1);
        assert_ne!(moved.configuration.permission_basis(), original.configuration.permission_basis());
        assert_eq!(retained.configuration.permission_basis(), target_original.configuration.permission_basis());
        assert_eq!(fixture.session(&source_session).await.get_session::<Value>(&source_session).await.unwrap().unwrap().configuration, source_stored);
        assert_eq!(fixture.session(target_id).await.get_session::<Value>(target_id).await.unwrap().unwrap().configuration, target_stored);
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn projects_original_receipt_survives_reactivation_without_repeating_the_change() {
    let mut fixture = Fixture::new("http://127.0.0.1:1/v1", None).await;
    let session = fixture.create("Original project").await;
    let selected = projects(&fixture).await["projects"][0]["reference"].clone();
    let operation = Uuid::new_v4();
    let result = fixture
        .mutation(
            2,
            "project",
            json!({"kind":"rename","project":selected,"name":"Persisted project"}),
            operation,
        )
        .await
        .unwrap();
    let source = fixture.app.source().unwrap().clone();
    let reference = fixture
        .store
        .application_intents(source.deployment, id(2), 0, 16)
        .await
        .unwrap()
        .into_iter()
        .find(|entry| entry.reference.operation == operation)
        .unwrap()
        .reference;
    let before = fixture
        .store
        .get_project(selected["id"].as_str().unwrap())
        .await
        .unwrap()
        .unwrap();
    let roots = fixture.owner.settings.workspace_roots.clone();
    let policy = Arc::new(Grant(fixture.issuer.clone(), None));
    workspaces::publish_with_policy(&mut fixture, roots, policy).await;
    let client = fixture.app.client();
    let recovered = client
        .recover(
            client.activation(&id(2)).unwrap(),
            reference,
            scope(&fixture.issuer, true),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        recovered.outcome,
        OperationOutcome::Returned { value: result }
    );
    assert_eq!(
        fixture
            .store
            .get_project(&before.id)
            .await
            .unwrap()
            .unwrap(),
        before
    );
    assert_eq!(
        projects(&fixture).await["projects"][0]["name"],
        "Persisted project"
    );
    assert_eq!(
        fixture
            .query("observe", json!({"sessionId":session}))
            .await
            .unwrap()["session"]["workspace"]["projectId"],
        before.id
    );
    assert_eq!(
        fixture
            .store
            .application_intents(source.deployment, id(2), 0, 16)
            .await
            .unwrap()
            .len(),
        2
    );
    fixture.app.shutdown().await.unwrap();
    fixture.config.shutdown().await.unwrap();
}

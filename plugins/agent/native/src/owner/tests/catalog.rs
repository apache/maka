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
use maka_agent_facts::interaction::ClosureReason;
use maka_agent_facts::interaction::InteractionOutcome;
use maka_host_runtime::application::Subscription;

async fn next(stream: &mut Subscription) -> Value {
    tokio::time::timeout(Duration::from_secs(5), stream.recv())
        .await
        .expect("catalog update")
        .expect("live subscription")
}

#[tokio::test]
async fn catalog_observes_metadata_pending_and_removal_at_its_original_location() {
    let fixture = Fixture::new("http://127.0.0.1:1/v1", None).await;
    let mut bootstrap = fixture
        .app
        .client()
        .subscribe(
            fixture.binding(2).await,
            "catalog".into(),
            json!({"filter":"all","position":{"kind":"start"}}),
            scope(&fixture.issuer, true),
            Attachments::new().into(),
        )
        .await
        .unwrap();
    assert_eq!(next(&mut bootstrap).await["sessions"], json!([]));
    let mut ids = Vec::new();
    for title in ["First", "Second", "Third"] {
        ids.push(fixture.create(title).await);
        assert!(
            !next(&mut bootstrap).await["sessions"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
    bootstrap.completion().await;
    ids.sort();
    let owned_scope = json!({"kind":"workspace","sessionId":ids[0]});
    let first_title = fixture
        .query(
            "list",
            json!({
                "filter":"all","position":{"kind":"start"},
                "scope":owned_scope,"titleQuery":"First"
            }),
        )
        .await
        .unwrap();
    assert_eq!(first_title["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(first_title["sessions"][0]["title"], "First");
    for (scope, title) in [
        (owned_scope.clone(), "Second"),
        (json!({"kind":"workspace","sessionId":ids[1]}), "First"),
        (json!({"kind":"all"}), "First"),
    ] {
        let changed = fixture.query("list", json!({
            "filter":"all","position":{"kind":"after","revision":first_title["revision"],"cursor":first_title["sessions"][0]["id"]},
            "scope":scope,"titleQuery":title
        })).await.unwrap_err();
        assert!(changed.contains("agent_catalog_changed"), "{changed}");
    }
    let defaults = fixture
        .query("list", json!({"filter":"all","position":{"kind":"start"}}))
        .await
        .unwrap();
    let explicit = fixture.query("list", json!({"filter":"all","position":{"kind":"start"},"scope":{"kind":"all"},"titleQuery":""})).await.unwrap();
    assert_eq!(
        defaults, explicit,
        "omitted and empty query have one catalog identity"
    );
    let unavailable = fixture.query("list", json!({
        "filter":"all","position":{"kind":"start"},"scope":{"kind":"workspace","sessionId":"foreign"}
    })).await.unwrap_err();
    assert!(
        unavailable.contains("agent_session_unavailable"),
        "{unavailable}"
    );
    assert_eq!(
        fixture
            .query(
                "list",
                json!({"filter":"all","position":{"kind":"start"},"titleQuery":"界".repeat(128)})
            )
            .await
            .unwrap()["sessions"],
        json!([])
    );
    assert_eq!(
        fixture
            .query(
                "list",
                json!({"filter":"all","position":{"kind":"start"},"titleQuery":"界".repeat(129)})
            )
            .await
            .unwrap()["sessions"],
        json!([])
    );
    let mut filtered = fixture.app.client().subscribe(
        fixture.binding(2).await, "catalog".into(),
        json!({"filter":"all","position":{"kind":"start"},"scope":owned_scope,"titleQuery":"Updated"}),
        scope(&fixture.issuer, true), Attachments::new().into(),
    ).await.unwrap();
    assert_eq!(next(&mut filtered).await["sessions"], json!([]));
    let mut stream = fixture
        .app
        .client()
        .subscribe(
            fixture.binding(2).await,
            "catalog".into(),
            json!({"filter":"all","position":{"kind":"at","cursor":ids[1]}}),
            scope(&fixture.issuer, true),
            Attachments::new().into(),
        )
        .await
        .unwrap();
    let first = next(&mut stream).await;
    assert_eq!(first["sessions"][0]["id"], ids[1]);
    assert_eq!(first["sessions"].as_array().unwrap().len(), 2);
    assert_eq!(first["needsYouCount"], 0);
    assert_eq!(first["before"], ids[1]);

    let changed = fixture
        .mutation(
            2,
            "metadata",
            json!({
                "sessionId":ids[1],"expectedRevision":first["sessions"][0]["revision"],
                "title":"Updated while reading","labels":[],
            }),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
    assert_eq!(changed["kind"], "committed");
    let renamed = next(&mut stream).await;
    assert_eq!(renamed["sessions"][0]["title"], "Updated while reading");
    let matched = next(&mut filtered).await;
    assert_eq!(matched["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(matched["sessions"][0]["id"], ids[1]);
    assert_eq!(matched["sessions"][0]["title"], "Updated while reading");
    assert_eq!(fixture.query("list", json!({"filter":"all","position":{"kind":"start"},"scope":owned_scope,"titleQuery":"updated"})).await.unwrap()["sessions"], json!([]), "title substring matching is case-sensitive");
    fixture
        .store
        .set_session_archived::<StoredSessionConfiguration>(&ids[1], true, 3)
        .await
        .unwrap();
    let archived = next(&mut stream).await;
    assert_eq!(archived["sessions"][0]["id"], ids[2]);
    assert_eq!(
        next(&mut filtered).await["sessions"],
        json!([]),
        "a catalog update replaces its filtered window"
    );
    filtered.cancel();
    tokio::time::timeout(Duration::from_secs(5), filtered.completion())
        .await
        .unwrap();

    // Background pending sessions outside this page contribute to the exact count.
    fixture
        .session(&(catalog_interaction(&ids[0], "background")).session_id)
        .await
        .establish_interaction(&catalog_interaction(&ids[0], "background"))
        .await
        .unwrap();
    let pending = next(&mut stream).await;
    assert_eq!(pending["needsYouCount"], 1);
    assert_eq!(pending["sessions"][0]["id"], ids[2]);
    fixture
        .session(&(catalog_interaction(&ids[0], "background-second")).session_id)
        .await
        .establish_interaction(&catalog_interaction(&ids[0], "background-second"))
        .await
        .unwrap();
    assert_eq!(
        next(&mut stream).await["needsYouCount"],
        1,
        "count sessions, not requests"
    );

    fixture
        .store
        .create_session(
            "foreign",
            "foreign",
            &json!({"invalidPrivateConfiguration":true}),
            1,
        )
        .await
        .unwrap();
    assert_eq!(next(&mut stream).await["sessions"], pending["sessions"]);
    fixture
        .session(&(catalog_interaction("foreign", "foreign-request")).session_id)
        .await
        .establish_interaction(&catalog_interaction("foreign", "foreign-request"))
        .await
        .unwrap();
    let private = next(&mut stream).await;
    assert_eq!(private["needsYouCount"], 1);
    assert_eq!(private["sessions"], pending["sessions"]);

    for request in ["background", "background-second"] {
        fixture
            .session(&ids[0])
            .await
            .commit_interaction_outcome(
                request,
                InteractionOutcome::Closure {
                    reason: ClosureReason::ProducerCancelled,
                    committed_at: 20,
                },
            )
            .await
            .unwrap();
        let updated = next(&mut stream).await;
        assert_eq!(
            updated["needsYouCount"],
            if request == "background" { 1 } else { 0 }
        );
    }
    for id in &ids[1..] {
        let record = fixture
            .session(id)
            .await
            .get_session::<StoredSessionConfiguration>(id)
            .await
            .unwrap()
            .unwrap();
        fixture
            .store
            .begin_session_removal(id, record.revision)
            .await
            .unwrap();
        let updated = next(&mut stream).await;
        assert!(
            updated["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .all(|row| row["id"] != *id)
        );
        if id == &ids[2] {
            assert_eq!(
                updated["sessions"][0]["id"], ids[0],
                "empty tail falls back in the same owner scope"
            );
            assert!(updated["before"].is_null());
            assert!(updated["after"].is_null());
            assert_eq!(
                updated["needsYouCount"], 0,
                "foreign pending session stays excluded"
            );
        }
    }
    stream.cancel();
    tokio::time::timeout(Duration::from_secs(5), stream.completion())
        .await
        .unwrap();
    fixture.app.shutdown().await.unwrap();
    fixture.config.shutdown().await.unwrap();
}

#[tokio::test]
async fn explicit_read_marker_keeps_original_tail_authority_and_receipt() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            for text in ["First answer", "New answer"] {
                let (mut socket, _) = listener.accept().await.unwrap();
                request(&mut socket).await;
                response_with_text(&mut socket, text).await;
            }
        });
        let fixture = Fixture::new(&base, None).await;
        let session = fixture.create("Read marker").await;
        let read = |message: &str| json!({"sessionId":session,"messageId":message});
        let initial = fixture.query("observe", json!({"sessionId":session})).await.unwrap();
        assert_eq!(initial["session"]["tailMessageId"], Value::Null);
        assert_eq!(initial["session"]["hasUnread"], false);
        fixture.send(&session).await.unwrap();
        fixture.drained().await;
        let first = fixture
            .query("observe", json!({"sessionId":session}))
            .await
            .unwrap();
        assert_eq!(first["session"]["hasUnread"], true);
        let page = fixture
            .query(
                "history",
                json!({"sessionId":session,"position":{"kind":"tail"}}),
            )
            .await
            .unwrap();
        let message = page["chunks"].as_array().unwrap().last().unwrap()["messageId"]
            .as_str()
            .unwrap();
        assert_eq!(first["session"]["tailMessageId"], message);
        let stale = fixture
            .mutation(2, "markRead", read("unknown-message"), Uuid::new_v4())
            .await
            .unwrap();
        assert_eq!(stale["session"], first["session"]);
        let operation = Uuid::new_v4();
        let marked = fixture
            .mutation(2, "markRead", read(message), operation)
            .await
            .unwrap();
        assert_eq!(marked["kind"], "observed");
        assert_eq!(marked["session"]["hasUnread"], false);
        assert_eq!(marked["session"]["tailMessageId"], message);
        assert_eq!(
            marked["session"]["updatedAt"],
            first["session"]["updatedAt"]
        );
        let revision = marked["session"]["revision"].as_u64().unwrap();
        assert_eq!(revision, first["session"]["revision"].as_u64().unwrap() + 1);
        let duplicate = fixture
            .mutation(2, "markRead", read(message), Uuid::new_v4())
            .await
            .unwrap();
        assert_eq!(duplicate, marked);
        fixture.send(&session).await.unwrap();
        fixture.drained().await;
        let second = fixture
            .query("observe", json!({"sessionId":session}))
            .await
            .unwrap();
        assert_eq!(second["session"]["hasUnread"], true);
        assert_eq!(
            fixture
                .mutation(2, "markRead", read(message), operation)
                .await
                .unwrap(),
            marked,
            "original receipt replay cannot clear later unread"
        );
        assert_eq!(
            fixture
                .mutation(2, "markRead", read(message), Uuid::new_v4())
                .await
                .unwrap()["session"],
            second["session"],
            "older message cannot clear the new tail"
        );
        fixture
            .store
            .create_session("foreign_session", "foreign", &json!({"foreign":true}), 1)
            .await
            .unwrap();
        assert_eq!(
            fixture
                .mutation(
                    2,
                    "markRead",
                    json!({"sessionId":"foreign_session","messageId":message}),
                    Uuid::new_v4()
                )
                .await
                .unwrap()["kind"],
            "rejected",
            "Agent cannot mark a foreign session"
        );
        let page = fixture
            .query(
                "history",
                json!({"sessionId":session,"position":{"kind":"tail"}}),
            )
            .await
            .unwrap();
        let latest = page["chunks"].as_array().unwrap().last().unwrap()["messageId"]
            .as_str()
            .unwrap();
        assert_eq!(second["session"]["tailMessageId"], latest);
        assert_eq!(
            fixture
                .mutation(2, "markRead", read(latest), Uuid::new_v4())
                .await
                .unwrap()["session"]["hasUnread"],
            false
        );
        let stored = fixture
            .session(&session)
            .await
            .get_session::<StoredSessionConfiguration>(&session)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            stored.read_state.last_read_message_id.as_deref(),
            Some(latest)
        );
        fixture
            .store
            .set_session_archived::<StoredSessionConfiguration>(&session, true, now())
            .await
            .unwrap();
        assert_eq!(
            fixture
                .mutation(2, "markRead", read(latest), Uuid::new_v4())
                .await
                .unwrap()["kind"],
            "rejected",
            "archived sessions retain their original state"
        );
        server.await.unwrap();
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn session_lifecycle_is_revision_checked_reversible_and_scoped() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let f = Fixture::new("http://127.0.0.1:1/v1", None).await;
        let session = f.create("Remove this conversation").await;
        let other = f.create("Keep this conversation").await;
        let file = f.workspace.join("keep.txt");
        std::fs::write(&file, "user work").unwrap();
        let mut revision = 1;
        for action in ["archive", "restore"] {
            let result = f
                .mutation(
                    2,
                    "changeSession",
                    json!({"sessionId":session,"expectedRevision":revision,"action":action}),
                    Uuid::new_v4(),
                )
                .await
                .unwrap();
            assert_eq!(result["kind"], "changed");
            assert_eq!(result["session"]["archived"], action == "archive");
            revision = result["session"]["revision"].as_u64().unwrap();
        }
        let stale = f
            .mutation(
                2,
                "changeSession",
                json!({"sessionId":session,"expectedRevision":1,"action":"remove"}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(stale["kind"], "revision_conflict");
        f.session(&(catalog_interaction(&session, "pending-delete")).session_id)
            .await
            .establish_interaction(&catalog_interaction(&session, "pending-delete"))
            .await
            .unwrap();
        revision = f
            .session(&session)
            .await
            .get_session::<StoredSessionConfiguration>(&session)
            .await
            .unwrap()
            .unwrap()
            .revision;
        let busy = f
            .mutation(
                2,
                "changeSession",
                json!({"sessionId":session,"expectedRevision":revision,"action":"remove"}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(busy["reason"], "busy");
        f.session(&session)
            .await
            .commit_interaction_outcome(
                "pending-delete",
                InteractionOutcome::Closure {
                    reason: ClosureReason::ProducerCancelled,
                    committed_at: now(),
                },
            )
            .await
            .unwrap();
        revision = f
            .session(&session)
            .await
            .get_session::<StoredSessionConfiguration>(&session)
            .await
            .unwrap()
            .unwrap()
            .revision;
        let removed = f
            .mutation(
                2,
                "changeSession",
                json!({"sessionId":session,"expectedRevision":revision,"action":"remove"}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(removed["kind"], "removed");
        f.drained().await;
        assert!(
            f.session(&session)
                .await
                .get_session::<StoredSessionConfiguration>(&session)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            f.session(&other)
                .await
                .get_session::<StoredSessionConfiguration>(&other)
                .await
                .unwrap()
                .is_some()
        );
        assert_eq!(std::fs::read_to_string(file).unwrap(), "user work");
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn k64_complete_session_metadata_persists_and_remains_searchable() {
    let fixture = Fixture::new("http://127.0.0.1:1/v1", None).await;
    let title = "Complete authored conversation title ".repeat(20);
    let labels: Vec<_> = (0..40)
        .map(|index| format!("{index}: {}", "Complete authored label ".repeat(10)))
        .collect();
    let mut input = fixture.create_input(&title).await;
    input["labels"] = json!(labels);
    let created = fixture
        .mutation(2, "create", input, Uuid::new_v4())
        .await
        .unwrap();
    assert_eq!(created["session"]["title"], title);
    assert_eq!(created["session"]["labels"], json!(labels));
    let id = created["session"]["id"].as_str().unwrap();
    let stored = fixture.owner.session(id).await.unwrap();
    assert_eq!(stored.configuration.title, title);
    assert_eq!(stored.configuration.labels, labels);
    let found = fixture
        .query(
            "list",
            json!({
                "filter":"all", "position":{"kind":"start"}, "titleQuery":title
            }),
        )
        .await
        .unwrap();
    assert_eq!(found["sessions"][0]["id"], id);
    assert_eq!(found["sessions"][0]["title"], title);
    fixture.app.shutdown().await.unwrap();
    fixture.config.shutdown().await.unwrap();
}

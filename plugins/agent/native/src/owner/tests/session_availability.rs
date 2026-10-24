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

#[tokio::test]
async fn session_read_guards_reject_foreign_missing_and_logically_removed_sessions() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let fixture = Fixture::new("http://127.0.0.1:9/v1", None).await;
        let session = fixture.create("Availability").await;
        fixture.owner.require_session(&session).await.unwrap();
        let record = fixture.session(&session).await.get::<StoredSessionConfiguration>().await.unwrap().unwrap();
        fixture.store.create_session("foreign_session", "foreign", &record.configuration, now()).await.unwrap();
        let missing = format!("{}{}", fixture.owner.prefix, Uuid::new_v4().simple());
        fixture.store.begin_session_removal(&session, record.revision).await.unwrap();
        assert!(fixture.store.retiring_session::<StoredSessionConfiguration>(&session).await.unwrap().is_some());
        let row = json!({"sourceSequence":1,"itemIndex":0});
        let requests = [
            ("observe", json!({})),
            ("history", json!({"position":{"kind":"start"}})),
            ("historyLandmarks", json!({"through":0})),
            ("historyPrompt", json!({"through":1,"position":row})),
            ("search", json!({"through":0,"query":"needle","caseSensitive":false,"wholeWord":false,"includeInternal":false})),
            ("source", json!({"through":0,"source":{"kind":"row","position":row},"field":"body","position":{"kind":"start"}})),
            ("toolImage", json!({"through":0,"position":row,"offset":0})),
            ("attachmentImage", json!({"source":{"kind":"uploaded","id":"unknown"},"offset":0})),
        ];
        for id in ["foreign_session", missing.as_str(), session.as_str()] {
            assert_eq!(fixture.owner.require_session(id).await.unwrap_err(), "agent_session_unavailable");
            for (method, input) in &requests {
                let mut input = input.clone();
                input["sessionId"] = json!(id);
                let error = fixture.query(method, input).await.unwrap_err();
                assert!(error.contains("agent_session_unavailable"), "{method} {id}: {error}");
            }
            let mut watch = fixture.app.client().subscribe(fixture.binding(2).await, "watch".into(),
                json!({"sessionId":id,"after":0}), scope(&fixture.issuer, true),
                Attachments::new().into()).await.unwrap();
            assert!(watch.recv().await.is_none());
            let error = watch.completion().await.result.unwrap_err();
            assert!(error.contains("agent_session_unavailable"), "watch {id}: {error}");
        }
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn history_visibility_does_not_decode_configuration_but_source_still_requires_it() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let fixture = Fixture::new("http://127.0.0.1:9/v1", None).await;
        let session = fixture.create("History without configuration").await;
        let history_input = json!({"sessionId":session,"position":{"kind":"start"}});
        let expected = fixture
            .query("history", history_input.clone())
            .await
            .unwrap();
        assert_eq!(expected["kind"], "ready");
        assert_eq!(expected["chunks"], json!([]));
        let connection = rusqlite::Connection::open(fixture.session_database(&session)).unwrap();
        // Preserve valid JSON and the binding reference while making the domain
        // configuration undecodable; history only requires Session visibility.
        connection
            .execute(
                "UPDATE session_control SET configuration=json_set(configuration,'$.title',42) WHERE id=?",
                [&session],
            )
            .unwrap();
        drop(connection);
        fixture.owner.require_session(&session).await.unwrap();
        assert_eq!(
            fixture.owner.session(&session).await.err().unwrap(),
            "agent_store_unavailable"
        );
        assert_eq!(
            fixture
                .query("history", history_input.clone())
                .await
                .unwrap(),
            expected
        );
        let error = fixture
            .query(
                "source",
                json!({"sessionId":session,"through":0,
            "source":{"kind":"row","position":{"sourceSequence":1,"itemIndex":0}},
            "field":"body","position":{"kind":"start"}}),
            )
            .await
            .unwrap_err();
        assert!(error.contains("agent_store_unavailable"), "{error}");
        let cancelled = scope(&fixture.issuer, true);
        cancelled.cancellation.cancel();
        if let Ok(read) = fixture
            .app
            .client()
            .start(
                fixture.binding(2).await,
                "history".into(),
                history_input,
                cancelled,
                Attachments::new().into(),
            )
            .await
        {
            assert!(read.result().await.is_err());
        }
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

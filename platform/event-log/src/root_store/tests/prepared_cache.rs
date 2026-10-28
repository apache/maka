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
use crate::context::{prepared::gc, semantic::SemanticSelection};
use maka_agent_facts::model::prompt_source::WireFormat;

async fn drain(log: &EventLog) {
    for _ in 0..100 {
        let registry = log.prepared.clone();
        if !log
            .prepared_store()
            .unwrap()
            .run(move |connection, state| {
                Box::pin(async move { gc::maintain(connection, &registry, state).await })
            })
            .await
            .unwrap()
        {
            return;
        }
    }
    panic!("prepared cache did not drain");
}

#[tokio::test]
async fn prepared_head_replacement_and_removal_coalesce_pending_retirement_without_losing_leases() {
    let directory = tempfile::tempdir().unwrap();
    let root = RootStore::open(owner(directory.path())).await.unwrap();
    let session = root
        .create_session("cache", "fixture", &serde_json::json!({}), 1)
        .await
        .unwrap();
    let log = session.owner().unwrap();
    let selection = SemanticSelection {
        session: session.id().to_owned(),
        lineage: None,
        after: 0,
        anchor_sequence: None,
        through: 0,
        before: 1,
        captured_through: 0,
        replay: None,
        prior_unknown: false,
    };
    let build = session
        .prepare_model_view(selection.clone(), "first", None)
        .await
        .unwrap();
    let retained = session.finish_prepared(&build).await.unwrap();
    drop(build);
    let wire_build = session
        .prepare_wire_view(&retained, WireFormat::Responses, "first", None)
        .await
        .unwrap();
    let retained_wire = session.finish_prepared_wire(&wire_build).await.unwrap();
    drop(wire_build);
    let first: (String, String) = log.prepared_store().unwrap().run(|connection, _state| Box::pin(async move {
        let first = sqlx::query_as("SELECT build_id,wire_view_id FROM context_prepared_heads WHERE session_id='cache'")
            .fetch_one(&mut *connection).await?;
        // Install the already-enqueued schedule inside the publishing SQL statement,
        // so background maintenance cannot consume it between two fixture calls.
        // This adds no roots or leases: both are the real selected Session views above.
        sqlx::raw_sql("CREATE TRIGGER prepared_cache.test_pending_head_retirement BEFORE UPDATE ON context_prepared_heads
            BEGIN
                INSERT INTO context_prepared_retire SELECT 'build',OLD.build_id WHERE OLD.build_id IS NOT NEW.build_id ON CONFLICT(kind,id) DO NOTHING;
                INSERT INTO context_prepared_retire SELECT 'wire_view',OLD.wire_view_id WHERE OLD.wire_view_id IS NOT NULL AND OLD.wire_view_id IS NOT NEW.wire_view_id ON CONFLICT(kind,id) DO NOTHING;
            END;").execute(&mut *connection).await?;
        Ok(first)
    })).await.unwrap();

    let mut latest = None;
    for turn in 0..3 {
        let build = session
            .prepare_model_view(selection.clone(), &format!("successor-{turn}"), None)
            .await
            .unwrap();
        // Real finish_prepared publishes with INSERT ... ON CONFLICT DO UPDATE;
        // the original trigger's INSERT OR IGNORE fails with SQLite 1555 here.
        let view = session.finish_prepared(&build).await.unwrap();
        drop(build);
        let wire_build = session
            .prepare_wire_view(&view, WireFormat::Responses, "next", None)
            .await
            .unwrap();
        let wire = session.finish_prepared_wire(&wire_build).await.unwrap();
        drop(wire_build);
        latest = Some((view, wire));
        drain(&log).await;
        assert!(
            session
                .prepared_semantic_group(&retained, 0)
                .await
                .unwrap()
                .is_none()
        );
        let expected = first.clone();
        log.prepared_store().unwrap().read_interruptible(move |connection| Box::pin(async move {
            assert!(sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM context_prepared_builds WHERE id=? AND retiring=0)").bind(expected.0).fetch_one(&mut *connection).await?);
            assert!(sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM context_prepared_wire_views WHERE id=? AND retiring=0)").bind(expected.1).fetch_one(connection).await?);
            Ok(())
        })).await.unwrap();
    }
    log.prepared_store().unwrap().run(|connection, _state| Box::pin(async move {
        // Removal also encounters both identities already in the queue. Keep the
        // enqueue and real owner retirement in one SQL job to make this deterministic.
        sqlx::raw_sql("INSERT INTO context_prepared_retire SELECT 'build',build_id FROM context_prepared_heads WHERE session_id='cache' ON CONFLICT(kind,id) DO NOTHING;
            INSERT INTO context_prepared_retire SELECT 'wire_view',wire_view_id FROM context_prepared_heads WHERE session_id='cache' AND wire_view_id IS NOT NULL ON CONFLICT(kind,id) DO NOTHING;")
            .execute(&mut *connection).await?;
        gc::retire_owner(connection, "cache").await
    })).await.unwrap();
    drain(&log).await;
    assert!(
        session
            .prepared_semantic_group(&retained, 0)
            .await
            .unwrap()
            .is_none()
    );
    drop(retained);
    drop(retained_wire);
    drop(latest);
    drain(&log).await;
    log.prepared_store().unwrap().read_interruptible(|connection| Box::pin(async move {
        let counts: (i64,i64,i64,i64,i64) = sqlx::query_as("SELECT (SELECT COUNT(*) FROM context_prepared_heads),(SELECT COUNT(*) FROM context_prepared_builds),(SELECT COUNT(*) FROM context_prepared_wire_views),(SELECT COUNT(*) FROM context_prepared_retire),(SELECT COUNT(*) FROM context_prepared_refs)")
            .fetch_one(connection).await?;
        assert_eq!(counts, (0,0,0,0,0));
        Ok(())
    })).await.unwrap();
    root.shutdown().await.unwrap();
}

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
use crate::bundle::{fixtures as bundle_fixtures, frames, import as bundle_import};

#[tokio::test]
async fn bundle_checkpoint_requires_its_atomic_terminal_even_with_a_valid_transfer_digest() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("compact.sqlite"))
        .await
        .unwrap();
    log.create_session("session", "session", &json!({}), 1)
        .await
        .unwrap();
    open(&log, "old", false).await;
    end(&log, "old").await;
    open(&log, "compact", true).await;
    let source = log
        .capture_compaction_context(
            "session",
            Some("compact"),
            &CheckpointMode::Standalone,
            100_000,
            64 * 1024 * 1024,
        )
        .await
        .unwrap();
    let pair = summary_pair(&log, "compact", &source).await;
    log.append_batch(&pair).await.unwrap();
    let inventory = log.preview_bundle("session").await.unwrap();
    let (bytes, _) = log
        .export_bundle("session", &inventory.subtree_digest, Vec::new())
        .await
        .unwrap();
    let mut staged = maka_event_log::bundle::StagedBundle::read(bytes.as_slice())
        .await
        .unwrap();
    staged.validate_history().await.unwrap();
    staged.close().await.unwrap();
    bundle_import::roundtrip(&bytes).await;
    let altered = frames::rewrite_events(&bytes, |event| event["id"] != pair[1].event().id);
    maka_event_log::bundle::inspect(altered.as_slice())
        .await
        .unwrap();
    let mut staged = maka_event_log::bundle::StagedBundle::read(altered.as_slice())
        .await
        .unwrap();
    assert!(staged.validate_history().await.is_err());
    staged.close().await.unwrap();
    log.close().await.unwrap();
}

#[tokio::test]
async fn bundle_archive_closure_preserves_lineage_instead_of_exporting_intermediate_runs() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("bundle-lineage.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("session", "source", &json!({}), 1)
        .await
        .unwrap();
    let source = continuation::opening("source", None);
    continuation::append(&log, &source).await;
    let original = bundle_fixtures::tool(
        &log,
        &source.invocation,
        "source-tool",
        "original".repeat(2000),
    )
    .await;
    continuation::close(&log, &source).await;
    let base = log
        .context_before_run(&source.invocation, 100, 65536)
        .await
        .unwrap()
        .source_evidence;
    let claim = continuation::claim(
        &log,
        "continue-source",
        &source,
        SessionBase {
            high_water: base.high_water,
            digest: base.digest,
        },
    )
    .await;
    let mut unrelated = continuation::opening("unrelated", None);
    if let Fact::InvocationOpened {
        input: InvocationInput::Message { content, .. },
        ..
    } = &mut unrelated.fact
    {
        *content = "EXCLUDED INTERMEDIATE TURN".into();
    }
    continuation::append(&log, &unrelated).await;
    continuation::close(&log, &unrelated).await;
    let child = continuation::opening("child", Some(claim));
    continuation::append(&log, &child).await;
    let own = bundle_fixtures::tool(
        &log,
        &child.invocation,
        "child-tool",
        "child output".repeat(2000),
    )
    .await;
    // The first archive's target follows the excluded Run; using Session scope here leaks it.
    log.append(&archive("child", &own)).await.unwrap();
    log.append(&archive("child", &original)).await.unwrap();
    continuation::close(&log, &child).await;
    let revision = log
        .get_session::<serde_json::Value>("session")
        .await
        .unwrap()
        .unwrap()
        .revision;
    log.copy_session(
        maka_event_log::sessions::SessionCopy {
            source_session_id: "session".into(),
            target_session_id: "branch".into(),
            expected_source_revision: revision,
            purpose: maka_agent_facts::session::CopyPurpose::Branch {
                position: maka_agent_facts::session::ForkPosition::ThroughTurn {
                    turn_id: "source".into(),
                },
                side_conversation: false,
            },
        },
        &json!({}),
        2,
    )
    .await
    .unwrap();
    let inventory = log.preview_bundle("branch").await.unwrap();
    let (bytes, report) = log
        .export_bundle("branch", &inventory.subtree_digest, Vec::new())
        .await
        .unwrap();
    let exported = frames::records(&bytes, &report.digest);
    let mut staged = maka_event_log::bundle::StagedBundle::read(bytes.as_slice())
        .await
        .unwrap();
    staged.validate_history().await.unwrap();
    staged.close().await.unwrap();
    bundle_import::roundtrip(&bytes).await;
    let events: Vec<RuntimeEvent> = exported
        .iter()
        .filter(|r| r["kind"] == "event")
        .map(|r| serde_json::from_str(r["json"].as_str().unwrap()).unwrap())
        .collect();
    assert!(events.iter().any(|event| event.id == own.event().id));
    assert!(events.iter().any(|event| event.id == original.event().id));
    assert!(events.iter().any(|event| event.id == child.id));
    assert!(
        !events
            .iter()
            .any(|event| event.invocation.run_id == "unrelated")
    );
    assert!(!String::from_utf8_lossy(&bytes).contains("EXCLUDED INTERMEDIATE TURN"));
    log.close().await.unwrap();

    // Excluded, collected bodies must not become required by an overbroad collection check.
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute(
        "UPDATE event_log SET retained_json=event_json,body_digest='fixture',event_json=NULL WHERE invocation_id='unrelated'",
        [],
    ).unwrap();
    drop(db);
    let log = EventLog::open(&path).await.unwrap();
    let (_, repeated) = log
        .export_bundle("branch", &inventory.subtree_digest, Vec::new())
        .await
        .unwrap();
    assert_eq!(repeated.digest, report.digest);
    log.close().await.unwrap();
}

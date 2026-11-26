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

//! Canonical Agent facts and deterministic transactional indexes on the original Root.
//! This crate does not choose a next action, schedule work, or recreate live grants.
pub mod artifacts;
pub mod cells;
pub mod computer;
pub mod diagnostics;
pub mod external_effects;
pub mod external_publication;
pub mod external_steering;
pub mod fold;
pub mod interactions;
pub mod memory;
mod namespace;
pub mod operation;
pub mod queue;
pub mod recall;
pub mod room;
pub mod session_catalog;
pub mod session_history;
mod sql;
mod store;
pub mod usage;
pub use store::{
    Admission, AdmissionGuard, AnswerPage, CallerFence, CallerStatus, Change, CleanupFrontier,
    Commit, ContentBlob, DriverClaim, DriverDomain, DriverPurpose, Head, ImmutableContentBody,
    LocalResult, ModelCleanupItem, NotificationAttention, NotificationState, PublicationRead,
    ReadyCause, ReadyRun, RunObservation, SessionObligation, SessionQuiescence,
    SessionQuiescenceGuard, StopOutcome, StopRun, Store,
};

pub const MIGRATIONS: &[maka_event_log::migration::Migration] = &[
    maka_event_log::migration::Migration {
        version: 2,
        description: "agent canonical execution",
        sql: include_str!("../migrations/0002_agent.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 3,
        description: "agent request queue",
        sql: include_str!("../migrations/0003_queue.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 4,
        description: "agent interactions",
        sql: include_str!("../migrations/0004_interactions.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 5,
        description: "agent artifact manifests",
        sql: include_str!("../migrations/0005_artifacts.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 6,
        description: "agent session history",
        sql: include_str!("../migrations/0006_session_history.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 7,
        description: "agent session catalog",
        sql: include_str!("../migrations/0007_session_catalog.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 8,
        description: "durable cells",
        sql: include_str!("../migrations/0008_cells.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 9,
        description: "agent computer observations",
        sql: include_str!("../migrations/0009_computer.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 10,
        description: "external Host effects",
        sql: include_str!("../migrations/0010_external_effects.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 11,
        description: "agent usage and recall",
        sql: include_str!("../migrations/0011_usage_recall.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 12,
        description: "external task steering",
        sql: include_str!("../migrations/0012_external_steering.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 13,
        description: "immutable history snapshots",
        sql: include_str!("../migrations/0013_history_snapshot.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 14,
        description: "canonical continuation successor references",
        sql: include_str!("../migrations/0014_continuation.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 16,
        description: "immutable history snapshot ingestion",
        sql: include_str!("../migrations/0016_snapshot_ingest.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 17,
        description: "external workspace publication",
        sql: include_str!("../migrations/0017_external_publication.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 18,
        description: "immutable history snapshot positions",
        sql: include_str!("../migrations/0018_snapshot_positions.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 19,
        description: "immutable history snapshot navigation",
        sql: include_str!("../migrations/0019_snapshot_navigation.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 20,
        description: "safe canonical diagnostic projection",
        sql: include_str!("../migrations/0020_diagnostics.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 21,
        description: "immutable history snapshot catalog metadata",
        sql: include_str!("../migrations/0021_snapshot_catalog.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 22,
        description: "sparse historical source and diagnostic read indexes",
        sql: include_str!("../migrations/0022_read_indexes.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 24,
        description: "native input source and turn interruption indexes",
        sql: include_str!("../migrations/0024_native_turn_fence.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 25,
        description: "immutable snapshot model fact metadata",
        sql: include_str!("../migrations/0025_snapshot_model_metadata.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 26,
        description: "canonical transport and successful finish projections",
        sql: include_str!("../migrations/0026_execution_fences.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 27,
        description: "indexed material reference lookups",
        sql: include_str!("../migrations/0027_material_reference_indexes.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 28,
        description: "indexed ingest content foreign keys",
        sql: include_str!("../migrations/0028_ingest_content_reference_indexes.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 29,
        description: "original external task cleanup frontier",
        sql: include_str!("../migrations/0029_external_cleanup.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 30,
        description: "indexed original model cleanup and final settlement",
        sql: include_str!("../migrations/0030_model_cleanup.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 31,
        description: "indexed imported history positions",
        sql: include_str!("../migrations/0031_imported_history_position.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 32,
        description: "compact history search",
        sql: include_str!("../migrations/0032_compact_history_search.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 33,
        description: "derive adopted Run content",
        sql: include_str!("../migrations/0033_derived_snapshot_adoption.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 34,
        description: "locate immutable inventory pages",
        sql: include_str!("../migrations/0034_snapshot_inventory_pages.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 35,
        description: "own executor profile contents",
        sql: include_str!("../migrations/0035_profile_content_owners.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 37,
        description: "track proactive summary attempts",
        sql: include_str!("../migrations/0037_proactive_summary.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 38,
        description: "subagent presets",
        sql: include_str!("../migrations/0038_subagent_presets.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 39,
        description: "index external assistant messages in the session catalog",
        sql: include_str!("../migrations/0039_external_catalog_messages.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 40,
        description: "session rooms and messages",
        sql: include_str!("../migrations/0040_rooms.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 41,
        description: "index history tool result metadata",
        sql: include_str!("../migrations/0041_history_tool_metadata.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 43,
        description: "scoped ordinary memory",
        sql: include_str!("../migrations/0043_memory.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 44,
        description: "memory assertion metadata",
        sql: include_str!("../migrations/0044_memory_metadata.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 45,
        description: "memory version evidence",
        sql: include_str!("../migrations/0045_memory_evidence.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 46,
        description: "memory write resolution",
        sql: include_str!("../migrations/0046_memory_resolution.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 47,
        description: "missing external tool returns",
        sql: include_str!("../migrations/0047_missing_external_returns.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 48,
        description: "permission grant sources",
        sql: include_str!("../migrations/0048_permission_grant_sources.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 49,
        description: "session removal foreign-key indexes",
        sql: include_str!("../migrations/0049_session_removal_fk_indexes.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 50,
        description: "persist run output-limit continuation count",
        sql: include_str!("../migrations/0050_output_limit_continuations.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 51,
        description: "current memory recall and restricted evidence",
        sql: include_str!("../migrations/0051_memory_recall.sql"),
        configure: Some(memory::recall::configure_writer),
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 52,
        description: "room members, topic, reactions, pins, edits, and full-text search",
        sql: include_str!("../migrations/0052_room_overhaul.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 53,
        description: "persist consecutive retry streak state on runs",
        sql: include_str!("../migrations/0053_retry_streak.sql"),
        configure: None,
        data: Some(sql::migrate_retry_streak),
    },
    maka_event_log::migration::Migration {
        version: 54,
        description: "repair reordered queue projections",
        sql: include_str!("../migrations/0054_queue_reorder_projection.sql"),
        configure: None,
        data: Some(queue::rebuild_queue_projections),
    },
    maka_event_log::migration::Migration {
        version: 55,
        description: "index ended-unknown external effect observations and redaction links",
        sql: include_str!("../migrations/0055_external_effect_ended_unknown.sql"),
        configure: None,
        data: Some(recall::migrate_external_effect_observations),
    },
    maka_event_log::migration::Migration {
        version: 56,
        description: "session-scoped message submission keys",
        sql: include_str!("../migrations/0056_message_submissions.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 57,
        description: "track pinned memory, source visibility and legacy read provenance",
        sql: include_str!("../migrations/0057_pinned_memory.sql"),
        configure: None,
        data: Some(memory::migrate_pinned::migrate),
    },
    maka_event_log::migration::Migration {
        version: 58,
        description: "drop session visibility taint tracking and simplify memory replay",
        sql: include_str!("../migrations/0058_simplify_memory_replay.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 59,
        description: "drop redundant duplicate and prefix indexes",
        sql: include_str!("../migrations/0059_drop_duplicate_indexes.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 60,
        description: "drop stored folded column from agent_recall_messages",
        sql: include_str!("../migrations/0060_drop_recall_folded.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 61,
        description: "deduplicate Recall indexing at source and coalesce external streaming deltas",
        sql: include_str!("../migrations/0061_dedup_recall_index.sql"),
        configure: None,
        data: Some(recall::migrate_v58::run),
    },
    maka_event_log::migration::Migration {
        version: 62,
        description: "intern namespace surrogate keys for history and recall",
        sql: include_str!("../migrations/0062_namespace_surrogate_keys.sql"),
        configure: None,
        data: Some(namespace::migrate_namespace_surrogate_keys),
    },
    maka_event_log::migration::Migration {
        version: 64,
        description: "decode compressed contents in agent views and triggers",
        sql: include_str!("../migrations/0064_agent_views_content_decode.sql"),
        configure: None,
        data: None,
    },
    maka_event_log::migration::Migration {
        version: 66,
        description: "compress agent_cells bodies and intern usage JSON blobs",
        sql: include_str!("../migrations/0066_compress_cells_and_usage.sql"),
        configure: Some(maka_event_log::content::register_sql_functions),
        data: Some(cells::migrate_v66::migrate_compress_cells_and_usage),
    },
];

#[cfg(test)]
mod migration_tests {
    #[test]
    fn composed_product_migrations_initialize_upgrade_and_reopen() {
        let catalog: Vec<_> = maka_event_log::ROOT_MIGRATIONS
            .iter()
            .chain(super::MIGRATIONS)
            .copied()
            .collect();
        for through in [0, 41].into_iter().chain(46..=65) {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("root.sqlite");
            let db = rusqlite::Connection::open(&path).unwrap();
            if through > 0 {
                let previous: Vec<_> = catalog
                    .iter()
                    .filter(|m| m.version <= through)
                    .copied()
                    .collect();
                maka_event_log::migration::run(&db, &previous).unwrap();
            }
            maka_event_log::migration::run(&db, &catalog).unwrap();
            drop(db);
            let db = rusqlite::Connection::open(&path).unwrap();
            maka_event_log::migration::run(&db, &catalog).unwrap();
            let identities: i64 = db
                .query_row(
                    "SELECT COUNT(*) FROM checkpoint_repository_sessions",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(identities, 0);
            for table in [
                "agent_session_history",
                "agent_recall_messages",
                "agent_recall_external_segments",
                "agent_usage_calls",
            ] {
                let has_ns_id: bool = db
                    .query_row(
                        &format!(
                            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('{table}') WHERE name='namespace_id')"
                        ),
                        [],
                        |r| r.get(0),
                    )
                    .unwrap();
                assert!(has_ns_id, "migration 61 must add namespace_id to {table}");
                let has_owner: bool = db
                    .query_row(
                        &format!(
                            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('{table}') WHERE name IN ('owner','session'))"
                        ),
                        [],
                        |r| r.get(0),
                    )
                    .unwrap();
                assert!(
                    !has_owner,
                    "migration 61 must drop owner/session from {table}"
                );
            }
            for dropped in [
                "agent_session_history_run_fk",
                "agent_session_history_result",
                "agent_memory_run_termination",
                "agent_usage_call_session_time",
            ] {
                let exists: bool = db
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name=?)",
                        [dropped],
                        |r| r.get(0),
                    )
                    .unwrap();
                assert!(!exists, "migration 61 must drop redundant index {dropped}");
            }
            for col in ["encoding", "logical_bytes"] {
                let exists: bool = db
                    .query_row(
                        &format!(
                            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('contents') WHERE name='{col}')"
                        ),
                        [],
                        |r| r.get(0),
                    )
                    .unwrap();
                assert!(exists, "migration 63 must add {col} to contents");
            }
            for view in [
                "agent_history_tool_metadata_source",
                "agent_memory_cell_accept_source",
                "agent_memory_cell_code_source",
                "agent_memory_cell_event_source",
                "agent_memory_cell_publication_source",
                "agent_memory_cell_return_source",
                "agent_memory_failed_terminations",
                "agent_memory_imported_tool_source",
                "agent_memory_operation_field_source",
                "agent_memory_recall_call_source",
                "agent_memory_selected_readers",
                "agent_memory_selection_readers",
                "agent_memory_termination_receipts",
            ] {
                let count: i64 = db
                    .query_row(&format!("SELECT COUNT(*) FROM {view}"), [], |r| r.get(0))
                    .unwrap();
                assert_eq!(count, 0, "migration 64 view {view} must query cleanly");
            }
        }
    }

    #[tokio::test]
    async fn compressed_contents_survive_store_reads_views_and_seekable_chunks() {
        use crate::artifacts::{ArtifactReadScope, ArtifactStore, SessionScope, Upload};
        use crate::store::{Admission, Change};
        use maka_agent_facts::{
            artifact::{Artifact, ArtifactKind, ArtifactSource},
            durable::{Fact, FactId, RunId, Terminal, UnixMillis},
            input::{MessageInput, RunInput},
        };
        use maka_event_log::{
            RootStore,
            root::{RootNamespaces, RootOwner},
        };
        use std::io::{Read, Seek, SeekFrom};
        use std::sync::Arc;

        let dir = tempfile::tempdir().unwrap();
        let namespaces = RootNamespaces {
            ownership: dir.path().join("owners"),
            control: dir.path().join("control"),
        };
        let root_path = dir.path().join("root");
        let catalog: Vec<_> = maka_event_log::ROOT_MIGRATIONS
            .iter()
            .chain(super::MIGRATIONS)
            .copied()
            .collect();
        // Seed a pre-v63 database with an uncompressed compressible blob first.
        let through_62: Vec<_> = catalog
            .iter()
            .filter(|m| m.version <= 62)
            .copied()
            .collect();
        let legacy_payload = "legacy-uncompressed-payload-".repeat(120).into_bytes();
        let legacy_blob = crate::ContentBlob::new(legacy_payload.clone());
        let legacy_digest = legacy_blob.reference().digest.clone();
        {
            let owner = Arc::new(RootOwner::create(&root_path, &namespaces).unwrap());
            let pre_root = RootStore::open(owner, &through_62).await.unwrap();
            pre_root.close().await.unwrap();
            let db =
                rusqlite::Connection::open(root_path.join(maka_event_log::root::ROOT_DATABASE))
                    .unwrap();
            legacy_blob.store_legacy(&db).unwrap();
        }

        // Reopen through the real RootStore so v63 + v64 migrate forward in place.
        let owner = Arc::new(RootOwner::open_existing(&root_path, &namespaces).unwrap());
        let root = RootStore::open(owner, &catalog).await.unwrap();
        let data = root.data_writer().unwrap();
        let store = crate::Store::new(
            data.clone(),
            crate::DriverDomain::new(data.clone()).unwrap(),
        )
        .unwrap();
        let artifacts = ArtifactStore::new(data.clone());

        // Admit a run with a large compressible user message so new rows land compressed.
        let (mut spec, mut blobs) = crate::store::stop_tests::spec();
        let long_text = "compressed-agent-message-segment-".repeat(80);
        let input_blob = crate::ContentBlob::json(&RunInput::Message {
            content: MessageInput::from(long_text.as_str()),
            request_fingerprint: None,
            source_messages: vec![],
        })
        .unwrap();
        spec.input = input_blob.reference().clone();
        blobs.push(input_blob);
        let run = RunId::new();
        let committed = store
            .admit(Admission::with_identity(
                run,
                spec.clone(),
                UnixMillis(1_700_000_000_000),
                blobs,
            ))
            .await
            .unwrap();
        let claim = store.claim(run).await.unwrap();
        store
            .append(
                &claim,
                committed.head,
                vec![Change {
                    id: FactId::new(),
                    at: UnixMillis(1_700_000_000_100),
                    fact: Fact::RunTerminated {
                        terminal: Terminal::Failed,
                        diagnostic: Some("failure-diagnostic-".repeat(40)),
                    },
                }],
                vec![],
            )
            .await
            .unwrap();
        drop(claim);

        // Upload a compressible artifact and read it via both chunk() and with_content().
        let artifact_bytes = "artifact-chunk-boundary-data-0123456789\n"
            .repeat(120)
            .into_bytes();
        let scope = SessionScope {
            owner: spec.owner.clone(),
            session: spec.session_id.clone(),
        };
        let artifact_id =
            maka_agent_facts::artifact::upload_artifact_id(&spec.session_id, "art-compress-1");
        let uploaded = artifacts
            .upload(Upload::new(
                scope.clone(),
                "op-compress-1".into(),
                "art-compress-1".into(),
                Artifact {
                    id: artifact_id.clone(),
                    session_id: spec.session_id.clone(),
                    turn_id: spec.turn_id.clone(),
                    created_at: 1_700_000_000_200,
                    name: "notes.txt".into(),
                    kind: ArtifactKind::File,
                    size_bytes: artifact_bytes.len() as u64,
                    mime_type: Some("text/plain".into()),
                    source: ArtifactSource::UserUpload,
                    summary: Some(maka_agent_facts::artifact::content_digest(&artifact_bytes)),
                },
                artifact_bytes.clone(),
            ))
            .await
            .unwrap();
        assert_eq!(uploaded.payload.bytes, artifact_bytes.len() as u64);

        let read_scope = ArtifactReadScope::Session {
            scope: scope.clone(),
        };
        let chunk = artifacts
            .chunk(read_scope.clone(), artifact_id.clone(), 137, 250)
            .await
            .unwrap()
            .expect("artifact chunk");
        assert_eq!(chunk.bytes, &artifact_bytes[137..387]);
        assert_eq!(chunk.total_bytes, artifact_bytes.len() as u64);

        let full = artifacts
            .with_content(read_scope, artifact_id, |_art, reader| {
                let mut buf = Vec::new();
                reader.read_to_end(&mut buf).unwrap();
                buf
            })
            .await
            .unwrap()
            .expect("artifact full read");
        assert_eq!(full, artifact_bytes);

        // Verify on-disk compression, ContentReader seeking, v64 views, and incremental re-encoding.
        let db_path = root_path.join(maka_event_log::root::ROOT_DATABASE);
        let db = rusqlite::Connection::open(&db_path).unwrap();
        maka_event_log::content::register_sql_functions(&db).unwrap();

        let (cid, enc, phys_len, log_len): (i64, i64, i64, Option<i64>) = db
            .query_row(
                "SELECT id, encoding, length(payload), logical_bytes FROM contents WHERE content_sha256=?",
                [&uploaded.payload.digest],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(enc, 1, "compressible artifact must be zstd-encoded");
        assert_eq!(log_len, Some(artifact_bytes.len() as i64));
        assert!(phys_len < artifact_bytes.len() as i64);

        let mut reader = maka_event_log::content::open_by_id(&db, cid).unwrap();
        assert_eq!(reader.len(), artifact_bytes.len() as u64);
        reader.seek(SeekFrom::Start(50)).unwrap();
        let mut slice = [0_u8; 64];
        reader.read_exact(&mut slice).unwrap();
        assert_eq!(&slice, &artifact_bytes[50..114]);
        reader.close().unwrap();

        let failed_rows: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM agent_memory_failed_terminations WHERE run=?",
                [run.to_string()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            failed_rows, 1,
            "v64 view must decode compressed termination fact"
        );

        // Pre-v63 blob must actually be recompressed in place by RootStore's background
        // maintenance worker, shrink physically, record logical_bytes, and remain verbatim readable.
        let legacy_id: i64 = db
            .query_row(
                "SELECT id FROM contents WHERE content_sha256=?",
                [&legacy_digest],
                |r| r.get(0),
            )
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let (legacy_enc, legacy_phys, legacy_logical) = loop {
            let row: (i64, i64, Option<i64>) = db
                .query_row(
                    "SELECT encoding, length(payload), logical_bytes FROM contents WHERE id=?",
                    [legacy_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .unwrap();
            if row.0 != maka_event_log::content::ENCODING_RAW
                || std::time::Instant::now() >= deadline
            {
                break row;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        };
        assert_ne!(
            legacy_enc,
            maka_event_log::content::ENCODING_RAW,
            "RootStore background maintenance must recompress legacy raw compressible blobs"
        );
        assert_eq!(legacy_logical, Some(legacy_payload.len() as i64));
        assert!(legacy_phys < legacy_payload.len() as i64);
        assert_eq!(
            maka_event_log::content::read(&db, &legacy_digest)
                .unwrap()
                .as_deref(),
            Some(legacy_payload.as_slice())
        );
        assert!(
            db.execute("UPDATE contents SET encoding=1 WHERE id=?", [legacy_id])
                .is_err(),
            "content_immutable must reject invalid encoding updates"
        );

        // Large (> 64 KiB) new artifact uses seekable framed zstd (encoding = 2) and supports
        // cross-frame chunk reads via Artifacts::chunk.
        let seekable_bytes: Vec<u8> = (0..5000)
            .flat_map(|i| {
                format!(
                    "seekable-artifact-line-{i:05}-compressible-segment
"
                )
                .into_bytes()
            })
            .collect();
        assert!(seekable_bytes.len() > maka_event_log::content::SEEKABLE_FRAME_BYTES * 3);
        let seekable_art_id =
            maka_agent_facts::artifact::upload_artifact_id(&spec.session_id, "art-seekable-1");
        let seekable_uploaded = artifacts
            .upload(Upload::new(
                scope.clone(),
                "op-seekable-1".into(),
                "art-seekable-1".into(),
                Artifact {
                    id: seekable_art_id.clone(),
                    session_id: spec.session_id.clone(),
                    turn_id: spec.turn_id.clone(),
                    created_at: 1_700_000_000_300,
                    name: "large.log".into(),
                    kind: ArtifactKind::File,
                    size_bytes: seekable_bytes.len() as u64,
                    mime_type: Some("text/plain".into()),
                    source: ArtifactSource::UserUpload,
                    summary: Some(maka_agent_facts::artifact::content_digest(&seekable_bytes)),
                },
                seekable_bytes.clone(),
            ))
            .await
            .unwrap();
        let (seek_enc, seek_phys, seek_logical): (i64, i64, Option<i64>) = db
            .query_row(
                "SELECT encoding, length(payload), logical_bytes FROM contents WHERE content_sha256=?",
                [&seekable_uploaded.payload.digest],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(seek_enc, maka_event_log::content::ENCODING_ZSTD_SEEKABLE);
        assert_eq!(seek_logical, Some(seekable_bytes.len() as i64));
        assert!(seek_phys < seekable_bytes.len() as i64);
        let cross_frame_off = (maka_event_log::content::SEEKABLE_FRAME_BYTES - 128) as u64;
        let seek_chunk = artifacts
            .chunk(
                ArtifactReadScope::Session {
                    scope: scope.clone(),
                },
                seekable_art_id,
                cross_frame_off,
                512,
            )
            .await
            .unwrap()
            .expect("seekable artifact chunk");
        assert_eq!(
            seek_chunk.bytes,
            &seekable_bytes[cross_frame_off as usize..cross_frame_off as usize + 512]
        );

        // Verify recall message index decoded the compressed input blob.
        let recall_hits: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM agent_recall_messages m
                 JOIN agent_namespaces ns ON ns.id = m.namespace_id
                 WHERE ns.session = ? AND m.body LIKE '%compressed-agent-message-segment%'",
                [&spec.session_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(recall_hits, 1, "recall must index compressed input message");
        drop(db);
        root.close().await.unwrap();
    }
}

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
    },
    maka_event_log::migration::Migration {
        version: 3,
        description: "agent request queue",
        sql: include_str!("../migrations/0003_queue.sql"),
    },
    maka_event_log::migration::Migration {
        version: 4,
        description: "agent interactions",
        sql: include_str!("../migrations/0004_interactions.sql"),
    },
    maka_event_log::migration::Migration {
        version: 5,
        description: "agent artifact manifests",
        sql: include_str!("../migrations/0005_artifacts.sql"),
    },
    maka_event_log::migration::Migration {
        version: 6,
        description: "agent session history",
        sql: include_str!("../migrations/0006_session_history.sql"),
    },
    maka_event_log::migration::Migration {
        version: 7,
        description: "agent session catalog",
        sql: include_str!("../migrations/0007_session_catalog.sql"),
    },
    maka_event_log::migration::Migration {
        version: 8,
        description: "durable cells",
        sql: include_str!("../migrations/0008_cells.sql"),
    },
    maka_event_log::migration::Migration {
        version: 9,
        description: "agent computer observations",
        sql: include_str!("../migrations/0009_computer.sql"),
    },
    maka_event_log::migration::Migration {
        version: 10,
        description: "external Host effects",
        sql: include_str!("../migrations/0010_external_effects.sql"),
    },
    maka_event_log::migration::Migration {
        version: 11,
        description: "agent usage and recall",
        sql: include_str!("../migrations/0011_usage_recall.sql"),
    },
    maka_event_log::migration::Migration {
        version: 12,
        description: "external task steering",
        sql: include_str!("../migrations/0012_external_steering.sql"),
    },
    maka_event_log::migration::Migration {
        version: 13,
        description: "immutable history snapshots",
        sql: include_str!("../migrations/0013_history_snapshot.sql"),
    },
    maka_event_log::migration::Migration {
        version: 14,
        description: "canonical continuation successor references",
        sql: include_str!("../migrations/0014_continuation.sql"),
    },
    maka_event_log::migration::Migration {
        version: 16,
        description: "immutable history snapshot ingestion",
        sql: include_str!("../migrations/0016_snapshot_ingest.sql"),
    },
    maka_event_log::migration::Migration {
        version: 17,
        description: "external workspace publication",
        sql: include_str!("../migrations/0017_external_publication.sql"),
    },
    maka_event_log::migration::Migration {
        version: 18,
        description: "immutable history snapshot positions",
        sql: include_str!("../migrations/0018_snapshot_positions.sql"),
    },
    maka_event_log::migration::Migration {
        version: 19,
        description: "immutable history snapshot navigation",
        sql: include_str!("../migrations/0019_snapshot_navigation.sql"),
    },
    maka_event_log::migration::Migration {
        version: 20,
        description: "safe canonical diagnostic projection",
        sql: include_str!("../migrations/0020_diagnostics.sql"),
    },
    maka_event_log::migration::Migration {
        version: 21,
        description: "immutable history snapshot catalog metadata",
        sql: include_str!("../migrations/0021_snapshot_catalog.sql"),
    },
    maka_event_log::migration::Migration {
        version: 22,
        description: "sparse historical source and diagnostic read indexes",
        sql: include_str!("../migrations/0022_read_indexes.sql"),
    },
    maka_event_log::migration::Migration {
        version: 24,
        description: "native input source and turn interruption indexes",
        sql: include_str!("../migrations/0024_native_turn_fence.sql"),
    },
    maka_event_log::migration::Migration {
        version: 25,
        description: "immutable snapshot model fact metadata",
        sql: include_str!("../migrations/0025_snapshot_model_metadata.sql"),
    },
    maka_event_log::migration::Migration {
        version: 26,
        description: "canonical transport and successful finish projections",
        sql: include_str!("../migrations/0026_execution_fences.sql"),
    },
    maka_event_log::migration::Migration {
        version: 27,
        description: "indexed material reference lookups",
        sql: include_str!("../migrations/0027_material_reference_indexes.sql"),
    },
    maka_event_log::migration::Migration {
        version: 28,
        description: "indexed ingest content foreign keys",
        sql: include_str!("../migrations/0028_ingest_content_reference_indexes.sql"),
    },
    maka_event_log::migration::Migration {
        version: 29,
        description: "original external task cleanup frontier",
        sql: include_str!("../migrations/0029_external_cleanup.sql"),
    },
    maka_event_log::migration::Migration {
        version: 30,
        description: "indexed original model cleanup and final settlement",
        sql: include_str!("../migrations/0030_model_cleanup.sql"),
    },
    maka_event_log::migration::Migration {
        version: 31,
        description: "indexed imported history positions",
        sql: include_str!("../migrations/0031_imported_history_position.sql"),
    },
    maka_event_log::migration::Migration {
        version: 32,
        description: "compact history search",
        sql: include_str!("../migrations/0032_compact_history_search.sql"),
    },
    maka_event_log::migration::Migration {
        version: 33,
        description: "derive adopted Run content",
        sql: include_str!("../migrations/0033_derived_snapshot_adoption.sql"),
    },
    maka_event_log::migration::Migration {
        version: 34,
        description: "locate immutable inventory pages",
        sql: include_str!("../migrations/0034_snapshot_inventory_pages.sql"),
    },
    maka_event_log::migration::Migration {
        version: 35,
        description: "own executor profile contents",
        sql: include_str!("../migrations/0035_profile_content_owners.sql"),
    },
    maka_event_log::migration::Migration {
        version: 37,
        description: "track proactive summary attempts",
        sql: include_str!("../migrations/0037_proactive_summary.sql"),
    },
    maka_event_log::migration::Migration {
        version: 38,
        description: "subagent presets",
        sql: include_str!("../migrations/0038_subagent_presets.sql"),
    },
    maka_event_log::migration::Migration {
        version: 39,
        description: "index external assistant messages in the session catalog",
        sql: include_str!("../migrations/0039_external_catalog_messages.sql"),
    },
    maka_event_log::migration::Migration {
        version: 40,
        description: "session rooms and messages",
        sql: include_str!("../migrations/0040_rooms.sql"),
    },
    maka_event_log::migration::Migration {
        version: 41,
        description: "index history tool result metadata",
        sql: include_str!("../migrations/0041_history_tool_metadata.sql"),
    },
    maka_event_log::migration::Migration {
        version: 43,
        description: "scoped ordinary memory",
        sql: include_str!("../migrations/0043_memory.sql"),
    },
    maka_event_log::migration::Migration {
        version: 44,
        description: "memory assertion metadata",
        sql: include_str!("../migrations/0044_memory_metadata.sql"),
    },
    maka_event_log::migration::Migration {
        version: 45,
        description: "memory version evidence",
        sql: include_str!("../migrations/0045_memory_evidence.sql"),
    },
    maka_event_log::migration::Migration {
        version: 46,
        description: "memory write resolution",
        sql: include_str!("../migrations/0046_memory_resolution.sql"),
    },
    maka_event_log::migration::Migration {
        version: 47,
        description: "missing external tool returns",
        sql: include_str!("../migrations/0047_missing_external_returns.sql"),
    },
    maka_event_log::migration::Migration {
        version: 48,
        description: "permission grant sources",
        sql: include_str!("../migrations/0048_permission_grant_sources.sql"),
    },
    maka_event_log::migration::Migration {
        version: 49,
        description: "session removal foreign-key indexes",
        sql: include_str!("../migrations/0049_session_removal_fk_indexes.sql"),
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
        for upgrade in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("root.sqlite");
            let db = rusqlite::Connection::open(&path).unwrap();
            if upgrade {
                let previous: Vec<_> = catalog
                    .iter()
                    .filter(|m| {
                        m.description != "checkpoint repository"
                            && m.description != "scoped ordinary memory"
                            && m.description != "memory assertion metadata"
                            && m.description != "memory version evidence"
                            && m.description != "memory write resolution"
                            && m.description != "missing external tool returns"
                            && m.description != "permission grant sources"
                    })
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
        }
    }
}

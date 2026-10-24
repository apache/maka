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

//! Exercise actual prior schemas and preserve their original durable evidence.
use std::{path::Path, sync::Arc};

use crate::{
    EventLog,
    connection::{ConnectionAuthority, OwnedConnection},
};
use maka_agent_facts::{
    artifact::{Artifact, ArtifactKind, ArtifactSource, content_digest},
    event::{EventWrite, Fact, Invocation, InvocationInput, InvocationOutcome, RuntimeEvent},
    session::{BranchOrigin, CopyPurpose, Lineage},
    tool_call::ToolCallIdentity,
    tool_output::ToolSuccess,
};
use rusqlite::Connection;
use serde_json::{Value, json};
use sqlx::sqlite::SqliteConnectOptions;

// Run the real historical migrations. Seed only APIs whose storage contract
// predates the migration under test; new derived-state readers need current schema.
// No migration ledger entry or checksum is removed to manufacture an old schema.
async fn open_at<const VERSION: i64>(path: &Path) -> EventLog {
    let mut lock_path = path.as_os_str().to_os_string();
    lock_path.push(".writer.lock");
    let lease = Arc::new(crate::root::FileLease::acquire(Path::new(&lock_path)).unwrap());
    let connection = OwnedConnection::open(
        SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true),
        ConnectionAuthority::Writer { lease, root: None },
        move |connection| {
            Box::pin(async move {
                sqlx::raw_sql(
                    "PRAGMA auto_vacuum = INCREMENTAL; PRAGMA application_id = 1296124754; PRAGMA temp_store = FILE;",
                )
                .execute(&mut *connection)
                .await?;
                crate::sqlite_functions::register(connection).await?;
                super::terminal_display::register(connection, true).await?;
                super::MIGRATIONS
                    .run_direct(Some(VERSION), &mut *connection, false)
                    .await?;
                super::terminal_display::register(connection, false).await?;
                sqlx::raw_sql("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;")
                    .execute(&mut *connection)
                    .await?;
                crate::message_sources::initialize(connection).await?;
                crate::sessions::initialize_execution(connection).await?;
                crate::transcript::directory::initialize(connection).await?;
                // Current append maintains these derived counters. Keep them
                // connection-local so the prior on-disk schema and migration
                // ledger stay genuine; migration 49 must backfill real tables.
                // temp_store is already FILE above, so later transcript-cache
                // initialization cannot discard these temporary tables.
                sqlx::raw_sql(
                    "CREATE TEMP TABLE session_usage_totals (
                        session_id TEXT PRIMARY KEY NOT NULL,
                        input_known INTEGER NOT NULL, input_missing INTEGER NOT NULL,
                        output_known INTEGER NOT NULL, output_missing INTEGER NOT NULL
                     ) STRICT;
                     CREATE TEMP TABLE session_usage_pending (
                        request_id TEXT PRIMARY KEY NOT NULL,
                        invocation_id TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE,
                        session_id TEXT NOT NULL
                     ) STRICT;",
                )
                .execute(&mut *connection)
                .await?;
                // Current Session projections read active interactions. This
                // historical fixture keeps that view connection-local: the old
                // canonical schema stays exact and migration 50 must create and
                // backfill the real durable membership on the later open.
                sqlx::raw_sql(
                    "CREATE TEMP VIEW interaction_pending AS
                     SELECT request_id, session_id, created_at FROM interaction_requests request
                     WHERE NOT EXISTS (SELECT 1 FROM interaction_outcomes outcome
                                       WHERE outcome.request_id=request.request_id);",
                )
                .execute(&mut *connection)
                .await?;
                let durable: i64 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM main.sqlite_schema
                     WHERE name IN ('session_usage_totals','session_usage_pending','interaction_pending')",
                )
                .fetch_one(&mut *connection)
                .await?;
                assert_eq!(durable, 0, "historical fixture gained durable projections");
                Ok(())
            })
        },
    )
    .await
    .unwrap();
    EventLog {
        expected_session: None,
        connection,
        root_owner: None,
        commits: crate::commits::CommitHub::new(0),
        prepared: crate::context::prepared::lifetime::PreparedRegistry::new(),
        shell_changes: tokio::sync::broadcast::channel(256).0,
    }
}

fn invocation() -> Invocation {
    Invocation {
        session_id: "original".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    }
}
fn event(fact: Fact) -> EventWrite {
    EventWrite::plain(RuntimeEvent::new(invocation(), fact)).unwrap()
}

// Historical schemas deliberately lack current ingress projections. Seed their
// literal canonical facts and pre-existing artifact/catalog contracts without
// routing through the current production ingress or fabricating new tables.
async fn append_historical(log: &EventLog, write: &EventWrite) {
    let write = write.clone();
    log.connection.run(move |connection| Box::pin(async move {
        use sqlx::Connection as _;
        let mut tx = connection.begin().await?;
        let event = write.event();
        let result = sqlx::query("INSERT INTO event_log(event_id,invocation_id,kind,operation_id,event_json) VALUES(?,?,?,?,?)")
            .bind(&event.id).bind(&event.invocation.invocation_id).bind(event.fact.kind())
            .bind(event.fact.operation_id()).bind(serde_json::to_string(event)?)
            .execute(&mut *tx).await?;
        let sequence = result.last_insert_rowid() as u64;
        crate::tool_payloads::insert(&mut tx, &write).await?;
        crate::artifacts::freeze_tool_media(&mut tx, event, sequence).await?;
        if matches!(event.fact, Fact::InvocationOpened { .. } | Fact::InvocationEnded { .. }) {
            crate::sessions::project_execution(&mut tx, sequence).await?;
            crate::sessions::advance_revision(&mut tx, &event.invocation.session_id).await?;
        }
        crate::transcript::directory::record_source(&mut tx, &event.invocation.session_id, sequence).await?;
        tx.commit().await?;
        Ok(())
    })).await.unwrap();
}

async fn seed_canonical_image(log: &EventLog) -> Artifact {
    log.create_session("original", "create", &json!({"name": "kept"}), 10)
        .await
        .unwrap();
    append_historical(
        log,
        &event(Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                source_messages: Vec::new(),
                content: "preserve image".into(),
                request_fingerprint: None,
            },
        }),
    )
    .await;
    append_historical(
        log,
        &event(Fact::ToolDispatched {
            presentation: None,
            title: None,
            operation_id: "image".into(),
            call: ToolCallIdentity::standalone("image-call".into()),
            name: "Read".into(),
            input: json!({}),
        }),
    )
    .await;
    let image = vec![
        71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 0, 0, 0, 255, 255, 255, 33, 249, 4, 1, 0, 0,
        0, 0, 44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 1, 68, 0, 59,
    ];
    let (result, _) = EventWrite::tool_success(
        "image-result".into(),
        std::time::SystemTime::now(),
        invocation(),
        "image".into(),
        ToolSuccess::image(image, "image/gif".into()).unwrap(),
    )
    .unwrap();
    let artifact = result.projection_artifacts()[0].artifact().clone();
    append_historical(log, &result).await;
    append_historical(
        log,
        &event(Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        }),
    )
    .await;
    seed_historical_copy(log).await;
    artifact
}

// This fixture must remain a real pre-40 database. The current copy entrypoint
// reads durable source/safety state that did not exist then; create the old
// branch records directly instead of adding fake new tables or migration rows.
async fn seed_historical_copy(log: &EventLog) {
    use sqlx::Connection as _;
    // The current public reader uses a separate SQL owner. Historical seeding
    // stays on the fixture connection, whose TEMP projections do not alter the
    // old on-disk schema or leak into a current-schema read owner.
    let source = log
        .connection
        .run(|connection| {
            Box::pin(async move { crate::sessions::read::<Value>(connection, "original").await })
        })
        .await
        .unwrap()
        .unwrap();
    let request = crate::sessions::SessionCopy {
        source_session_id: "original".into(),
        target_session_id: "copied".into(),
        expected_source_revision: source.revision,
        purpose: CopyPurpose::Branch {
            turn_id: None,
            side_conversation: false,
        },
    };
    let request = serde_json::to_string(&request).unwrap();
    let fingerprint = content_digest(request.as_bytes());
    let lineage = serde_json::to_string(&Lineage::Branch {
        origin: BranchOrigin {
            parent_session_id: "original".into(),
            turn_id: None,
        },
    })
    .unwrap();
    log.connection.run(move |connection| Box::pin(async move {
        let mut tx = connection.begin().await?;
        crate::sessions::insert(&mut tx,"copied",&fingerprint,r#"{"name":"copy"}"#,20).await?;
        let through: i64 = sqlx::query_scalar("SELECT MAX(sequence) FROM runtime_events")
            .fetch_one(&mut *tx).await?;
        sqlx::query("INSERT INTO session_history_copies(session_id,source_session_id,source_revision,through_sequence,observed_through,request_json,lineage_json,state) VALUES('copied','original',?,?,?,?,?,'committed')")
            .bind(source.revision as i64).bind(through).bind(through).bind(request).bind(lineage)
            .execute(&mut *tx).await?;
        sqlx::query("INSERT INTO session_history_members SELECT 'copied',sequence,NULL FROM runtime_events WHERE event_session='original' AND sequence<=?")
            .bind(through).execute(&mut *tx).await?;
        crate::artifacts::history::retain(&mut tx,"original","copied",20).await?;
        crate::transcript::directory::copy(&mut tx,"original","copied",through as u64).await?;
        tx.commit().await?;
        Ok(())
    })).await.unwrap();
}

fn current_version() -> i64 {
    super::MIGRATIONS
        .iter()
        .map(|migration| migration.version)
        .max()
        .unwrap()
}

type StoredArtifact = (String, String, i64, String, String, Vec<u8>, Option<i64>);
fn artifacts(db: &Connection) -> Vec<StoredArtifact> {
    db.prepare("SELECT session_id, id, created_at, record_json, content_sha256, payload, canonical_at FROM artifacts ORDER BY session_id, id")
        .unwrap().query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)))
        .unwrap().collect::<Result<_, _>>().unwrap()
}
fn mappings(db: &Connection) -> Vec<(String, String, String, String)> {
    db.prepare("SELECT session_id, source_session_id, source_artifact_id, artifact_id FROM session_history_artifacts ORDER BY session_id, source_session_id, source_artifact_id")
        .unwrap().query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
        .unwrap().collect::<Result<_, _>>().unwrap()
}
fn catalogs(db: &Connection) -> Vec<(String, i64)> {
    db.prepare("SELECT session_id, revision FROM artifact_catalog ORDER BY session_id")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

#[tokio::test]
async fn migration_36_preserves_canonical_images_and_copies_and_accepts_large_tool_originals() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("events.sqlite");
    let log = open_at::<35>(&path).await;
    let image = seed_canonical_image(&log).await;
    let upload_bytes = b"uncaptured upload";
    log.commit_artifact(
        Artifact {
            id: "uncaptured".into(),
            session_id: "original".into(),
            turn_id: "upload".into(),
            created_at: 21,
            name: "notes.txt".into(),
            kind: ArtifactKind::File,
            size_bytes: upload_bytes.len() as u64,
            mime_type: Some("text/plain".into()),
            source: ArtifactSource::UserUpload,
            summary: Some(content_digest(upload_bytes)),
        },
        upload_bytes,
    )
    .await
    .unwrap();
    // Compare canonical events across migration, without invoking the new
    // source-root reader against a deliberately historical schema.
    let through = log.navigation_fence("original").await.unwrap().unwrap();
    let facts = serde_json::to_vec(
        &log.session_events("original", 0, through, 32, 64 * 1024)
            .await
            .unwrap()
            .events,
    )
    .unwrap();
    let original = log.list_artifacts("original", 0, 128).await.unwrap();
    let copied = log.list_artifacts("copied", 0, 128).await.unwrap();
    log.close().await.unwrap();
    let db = Connection::open(&path).unwrap();
    assert_eq!(
        db.query_row("SELECT max(version) FROM _sqlx_migrations", [], |row| row
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        35
    );
    let prior = artifacts(&db);
    assert_eq!(prior.len(), 3);
    assert_eq!(
        prior
            .iter()
            .filter(|row| row.6.is_some_and(|at| at > 0))
            .count(),
        2
    );
    let uncaptured: Vec<_> = prior.iter().filter(|row| row.6.is_none()).collect();
    assert_eq!(uncaptured.len(), 1);
    assert_eq!(uncaptured[0].1, "uncaptured");
    let prior_mappings = mappings(&db);
    assert_eq!(prior_mappings.len(), 1);
    assert_eq!(prior_mappings[0].0, "copied");
    assert_eq!(prior_mappings[0].1, "original");
    assert_eq!(prior_mappings[0].2, image.id);
    let prior_catalogs = catalogs(&db);
    drop(db);

    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(
        serde_json::to_vec(&log.prefix(32, 64 * 1024).await.unwrap().events).unwrap(),
        facts
    );
    for (session, expected) in [("original", original), ("copied", copied)] {
        let actual = log.list_artifacts(session, 0, 128).await.unwrap();
        assert_eq!(actual.revision, expected.revision);
        assert_eq!(actual.total, expected.total);
        assert_eq!(actual.records, expected.records);
    }
    let db = Connection::open(&path).unwrap();
    assert_eq!(artifacts(&db), prior);
    assert_eq!(mappings(&db), prior_mappings);
    assert_eq!(catalogs(&db), prior_catalogs);
    assert_eq!(
        db.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap(),
        0
    );
    drop(db);

    let bytes = vec![0x5a; 50 * 1024 * 1024 + 1];
    let record = Artifact {
        id: "large-tool-original".into(),
        session_id: "original".into(),
        turn_id: "turn".into(),
        created_at: 30,
        name: "original.png".into(),
        kind: ArtifactKind::Image,
        size_bytes: bytes.len() as u64,
        mime_type: Some("image/png".into()),
        source: ArtifactSource::ToolResult,
        summary: Some(content_digest(&bytes)),
    };
    assert_eq!(
        log.commit_artifact(record.clone(), bytes).await.unwrap(),
        record
    );
    assert_eq!(
        log.read_artifact_chunk("original", &record.id, 50 * 1024 * 1024, 1)
            .await
            .unwrap()
            .unwrap()
            .bytes,
        [0x5a]
    );
    log.close().await.unwrap();
    let db = Connection::open(&path).unwrap();
    let stored: (i64, String) = db.query_row("SELECT length(payload), content_sha256 FROM artifacts WHERE id = 'large-tool-original'", [], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
    assert_eq!(stored.0, 50 * 1024 * 1024 + 1);
    assert_eq!(Some(stored.1), record.summary);
    assert_eq!(
        db.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap(),
        0
    );
}

#[tokio::test]
async fn migration_37_preserves_interaction_receipts_and_relations_without_json_quotas() {
    use maka_agent_facts::interaction::{
        Decision, GrantCapability, GrantScope, GrantTarget, InteractionOutcome, InteractionRecord,
        InteractionRequest, PermissionRequest,
    };
    use maka_sandbox::{Network, grant};

    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("interactions.sqlite");
    let log = open_at::<36>(&path).await;
    log.create_session("session", "create", &json!({"boundary_revision":4}), 1)
        .await
        .unwrap();
    let settled = InteractionRecord {
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        request_id: "settled".into(),
        created_at: 2,
        outcome: None,
        request: InteractionRequest::ClientCapability {
            tool_use_id: "tool".into(),
            basis: None,
            target: GrantTarget {
                provider_id: "provider".into(),
                contract_id: "contract".into(),
                server_id: "desktop_browser".into(),
                tool_name: "browser_navigate".into(),
                capability: GrantCapability::Browser,
                scope: GrantScope::BrowserOrigin {
                    origin: "https://example.com".into(),
                },
            },
        },
    };
    let pending = InteractionRecord {
        request_id: "pending".into(),
        ..settled.clone()
    };
    let permission = InteractionRecord {
        request_id: "permissions".into(),
        request: InteractionRequest::Permissions {
            tool_use_id: Some("tool".into()),
            basis: maka_agent_facts::workspace::PermissionBasis {
                boundary_revision: 4,
                binding: maka_agent_facts::workspace::BindingStamp {
                    id: uuid::Uuid::from_u128(1),
                    permission_epoch: 0,
                },
            },
            request: PermissionRequest {
                reason: "Original permission basis".into(),
                command: None,
                permissions: grant::Permissions {
                    filesystem: Vec::new(),
                    network: Network::Allowed,
                },
            },
        },
        ..settled.clone()
    };
    for record in [&settled, &pending] {
        assert!(log.establish_interaction(record).await.unwrap().matches);
    }
    // This pre-binding schema fixture retains original immutable permission
    // evidence directly; it must not resolve that historical stamp as authority.
    {
        let db = Connection::open(&path).unwrap();
        db.execute(
            "INSERT INTO interaction_requests VALUES(?,?,?,?)",
            rusqlite::params![
                permission.request_id,
                permission.session_id,
                permission.created_at as i64,
                serde_json::to_string(&permission).unwrap(),
            ],
        )
        .unwrap();
    }
    log.commit_interaction_outcome(
        "settled",
        InteractionOutcome::ClientCapabilityDecision {
            decision: Decision::Allow,
            committed_at: 3,
        },
    )
    .await
    .unwrap();
    let settled = log.interaction("settled").await.unwrap().unwrap();
    log.close().await.unwrap();

    fn rows(db: &Connection, table: &str, columns: &str) -> Vec<Vec<Value>> {
        let mut statement = db
            .prepare(&format!("SELECT {columns} FROM {table} ORDER BY 1, 2"))
            .unwrap();
        let count = statement.column_count();
        statement
            .query_map([], |row| {
                (0..count)
                    .map(|i| match row.get_ref(i)? {
                        rusqlite::types::ValueRef::Integer(n) => Ok(json!(n)),
                        rusqlite::types::ValueRef::Text(text) => {
                            Ok(json!(std::str::from_utf8(text).unwrap()))
                        }
                        rusqlite::types::ValueRef::Null => Ok(Value::Null),
                        _ => panic!("unexpected original durable column type"),
                    })
                    .collect()
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }
    let db = Connection::open(&path).unwrap();
    assert_eq!(
        db.query_row("SELECT max(version) FROM _sqlx_migrations", [], |row| row
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        36
    );
    db.execute_batch(
        "PRAGMA foreign_keys=ON;
        INSERT INTO projects VALUES
            ('00000000-0000-0000-0000-000000000001','identity-original','Original',10,NULL),
            ('00000000-0000-0000-0000-000000000002','identity-archived','Archived',11,12);
        INSERT INTO project_identities VALUES
            ('00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000001'),
            ('00000000-0000-0000-0000-000000000012','00000000-0000-0000-0000-000000000001'),
            ('00000000-0000-0000-0000-000000000021','00000000-0000-0000-0000-000000000002');
        INSERT INTO project_locations VALUES
            ('00000000-0000-0000-0000-000000000001','/original',0,13),
            ('00000000-0000-0000-0000-000000000001','/worktree',1,14),
            ('00000000-0000-0000-0000-000000000002','/archived',0,15);",
    )
    .unwrap();
    assert!(
        db.execute(
            "UPDATE projects SET name=?1 WHERE identity='identity-original'",
            ["完整".repeat(9000)]
        )
        .is_err()
    );
    assert!(
        db.execute(
            "UPDATE project_locations SET path=?1 WHERE path='/original'",
            [format!("/{}", "location/".repeat(600))]
        )
        .is_err()
    );
    let prior_ledger = rows(
        &db,
        "_sqlx_migrations WHERE version<=36",
        "version,hex(checksum)",
    );
    let tables = [
        (
            "interaction_requests",
            "request_id,session_id,created_at,record_json",
        ),
        ("interaction_outcomes", "request_id,outcome_json"),
        (
            "client_capability_session_grants",
            "authority_key,record_json",
        ),
        ("projects", "id,identity,name,last_used_at,archived_at"),
        ("project_identities", "id,project_id"),
        (
            "project_locations",
            "project_id,path,is_worktree,last_used_at",
        ),
    ];
    let original: Vec<_> = tables
        .iter()
        .map(|(table, columns)| rows(&db, table, columns))
        .collect();
    assert_eq!(
        original.iter().map(Vec::len).collect::<Vec<_>>(),
        vec![3, 1, 1, 2, 3, 3]
    );
    drop(db);

    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(log.interaction("settled").await.unwrap().unwrap(), settled);
    assert_eq!(log.interaction("pending").await.unwrap().unwrap(), pending);
    assert_eq!(
        log.interaction("permissions").await.unwrap().unwrap(),
        permission
    );
    let db = Connection::open(&path).unwrap();
    db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    assert_eq!(
        db.query_row("SELECT max(version) FROM _sqlx_migrations", [], |row| row
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        current_version()
    );
    for ((table, columns), original) in tables.iter().zip(original) {
        assert_eq!(rows(&db, table, columns), original);
    }
    assert_eq!(
        rows(
            &db,
            "_sqlx_migrations WHERE version<=36",
            "version,hex(checksum)"
        ),
        prior_ledger
    );
    for child in ["project_identities", "project_locations"] {
        let table: String = db
            .query_row(
                &format!("SELECT \"table\" FROM pragma_foreign_key_list('{child}')"),
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(table, "projects");
    }
    assert_eq!(db.query_row("SELECT count(*) FROM sqlite_schema WHERE type='index' AND name='project_identity_owner'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    for sql in [
        "INSERT INTO projects VALUES ('duplicate','identity-original','Name',1,NULL)",
        "INSERT INTO projects VALUES ('empty','empty','',1,NULL)",
        "INSERT INTO projects VALUES ('negative','negative','Name',-1,NULL)",
        "INSERT INTO projects VALUES ('future','future','Name',9007199254740992,NULL)",
        "INSERT INTO projects VALUES ('archived-invalid','archived-invalid','Name',1,-1)",
        "INSERT INTO projects VALUES ('blob','blob',x'61',1,NULL)",
        "INSERT INTO project_identities VALUES ('orphan','missing')",
        "INSERT INTO project_locations VALUES ('missing','/orphan',0,1)",
        "INSERT INTO project_locations VALUES ('00000000-0000-0000-0000-000000000001','',0,1)",
        "INSERT INTO project_locations VALUES ('00000000-0000-0000-0000-000000000001','/invalid',2,1)",
        "INSERT INTO project_locations VALUES ('00000000-0000-0000-0000-000000000001','/negative',0,-1)",
        "INSERT INTO project_locations VALUES ('00000000-0000-0000-0000-000000000001','/original',0,1)",
    ] {
        assert!(
            db.execute(sql, []).is_err(),
            "retained project constraint accepted {sql}"
        );
    }
    db.execute_batch(
        "INSERT INTO projects VALUES ('disposable','disposable','Disposable',1,NULL);
        INSERT INTO project_identities VALUES ('disposable-alias','disposable');
        INSERT INTO project_locations VALUES ('disposable','/disposable',1,1);
        DELETE FROM projects WHERE id='disposable';",
    )
    .unwrap();
    for child in ["project_identities", "project_locations"] {
        assert_eq!(
            db.query_row(
                &format!("SELECT count(*) FROM {child} WHERE project_id='disposable'"),
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }
    let complete_project = log
        .register_project(
            crate::projects::ProjectRegistration {
                identity: "complete-original".into(),
                name: "完整".repeat(9000),
                path: format!("/{}", "location/".repeat(600)),
                is_worktree: true,
            },
            true,
            20,
        )
        .await
        .unwrap();
    assert_eq!(complete_project.name, "完整".repeat(9000));
    assert_eq!(
        complete_project.locations[0].path,
        format!("/{}", "location/".repeat(600))
    );
    assert_eq!(
        db.query_row(
            "SELECT name FROM projects WHERE id=?1",
            [&complete_project.id],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        "完整".repeat(9000)
    );
    assert_eq!(
        db.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap(),
        0
    );
    assert_eq!(
        db.query_row(
            "SELECT \"table\" FROM pragma_foreign_key_list('interaction_outcomes')",
            [],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        "interaction_requests"
    );
    assert_eq!(db.query_row("SELECT count(*) FROM sqlite_schema WHERE type='index' AND name IN ('interaction_session_pending','interaction_permission_basis')", [], |row| row.get::<_, i64>(0)).unwrap(), 2);
    assert!(
        db.execute(
            "INSERT INTO interaction_outcomes VALUES ('orphan', '{}')",
            []
        )
        .is_err()
    );
    assert!(
        db.execute(
            "DELETE FROM interaction_requests WHERE request_id='settled'",
            []
        )
        .is_err()
    );
    assert!(
        db.execute(
            "INSERT INTO interaction_requests VALUES ('malformed','session',4,'{')",
            []
        )
        .is_err()
    );

    let complete = serde_json::to_string(&json!({"original":"中文😀".repeat(6000)})).unwrap();
    assert!(complete.len() > 20_480);
    db.execute(
        "INSERT INTO interaction_requests VALUES ('complete','session',4,?1)",
        [&complete],
    )
    .unwrap();
    db.execute(
        "INSERT INTO interaction_outcomes VALUES ('complete',?1)",
        [&complete],
    )
    .unwrap();
    db.execute(
        "INSERT INTO client_capability_session_grants VALUES ('complete',?1)",
        [&complete],
    )
    .unwrap();
    for (table, column) in [
        ("interaction_requests", "record_json"),
        ("interaction_outcomes", "outcome_json"),
        ("client_capability_session_grants", "record_json"),
    ] {
        let key = if table == "client_capability_session_grants" {
            "authority_key"
        } else {
            "request_id"
        };
        let actual: String = db
            .query_row(
                &format!("SELECT {column} FROM {table} WHERE {key}='complete'"),
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            actual == complete,
            "complete interaction JSON changed in {table}"
        );
    }
    // The historical outcomes table had no JSON CHECK. The application still
    // rejects malformed durable outcomes instead of treating them as receipts.
    db.execute(
        "INSERT INTO interaction_outcomes VALUES ('pending','{')",
        [],
    )
    .unwrap();
    assert!(log.interaction("pending").await.is_err());
    drop(db);
    log.close().await.unwrap();
}

#[tokio::test]
async fn migration_37_preserves_artifact_metadata_and_copied_image_provenance() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("artifact-metadata.sqlite");
    let log = open_at::<36>(&path).await;
    let image = seed_canonical_image(&log).await;
    let bytes = log
        .read_artifact_chunk("original", &image.id, 0, 32 * 1024)
        .await
        .unwrap()
        .unwrap()
        .bytes;
    let mut uncaptured = image.clone();
    uncaptured.id = "uncaptured-metadata".into();
    uncaptured.source = ArtifactSource::UserUpload;
    uncaptured.summary = Some(content_digest(&bytes));
    uncaptured.name = "uncaptured.gif".into();
    log.commit_artifact(uncaptured, bytes.clone())
        .await
        .unwrap();
    log.close().await.unwrap();

    let ledger = |db: &Connection| -> Vec<(i64, Vec<u8>)> {
        db.prepare(
            "SELECT version,checksum FROM _sqlx_migrations WHERE version<=36 ORDER BY version",
        )
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
    };
    let db = Connection::open(&path).unwrap();
    assert_eq!(
        db.query_row("SELECT max(version) FROM _sqlx_migrations", [], |row| row
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        36
    );
    let prior = artifacts(&db);
    assert_eq!(prior.len(), 3);
    assert_eq!(prior.iter().filter(|row| row.6.is_some()).count(), 2);
    assert_eq!(prior.iter().filter(|row| row.6.is_none()).count(), 1);
    let provenance = mappings(&db);
    assert_eq!(provenance.len(), 1);
    let revisions = catalogs(&db);
    let checksums = ledger(&db);
    assert!(db.execute("UPDATE artifacts SET record_json=json_set(record_json,'$.name',?1) WHERE session_id='original' AND id=?2", rusqlite::params![format!("{}.gif", "metadata".repeat(2400)), image.id]).is_err());
    drop(db);

    let log = EventLog::open(&path).await.unwrap();
    let db = Connection::open(&path).unwrap();
    db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    assert_eq!(
        db.query_row("SELECT max(version) FROM _sqlx_migrations", [], |row| row
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        current_version()
    );
    assert_eq!(artifacts(&db), prior);
    assert_eq!(mappings(&db), provenance);
    assert_eq!(catalogs(&db), revisions);
    assert_eq!(ledger(&db), checksums);
    assert_eq!(
        db.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap(),
        0
    );
    assert_eq!(db.query_row("SELECT \"table\" FROM pragma_foreign_key_list('session_history_artifacts') WHERE \"from\"='artifact_id'", [], |row| row.get::<_, String>(0)).unwrap(), "artifacts");
    assert_eq!(db.query_row("SELECT count(*) FROM sqlite_schema WHERE type='index' AND name='artifacts_session_order'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    for (field, value) in [
        ("sessionId", json!("foreign")),
        ("id", json!("different")),
        ("createdAt", json!(999)),
        ("sizeBytes", json!(bytes.len() + 1)),
    ] {
        assert!(db.execute("UPDATE artifacts SET record_json=json_set(record_json,?1,json(?2)) WHERE session_id='original' AND id=?3", rusqlite::params![format!("$.{field}"), value.to_string(), image.id]).is_err(), "original artifact identity check accepted {field}");
    }
    for sql in [
        "UPDATE artifacts SET canonical_at=0",
        "UPDATE artifacts SET created_at=-1",
        "UPDATE artifacts SET record_json='{'",
        "INSERT INTO artifacts SELECT * FROM artifacts LIMIT 1",
        "INSERT INTO session_history_artifacts VALUES ('copied','original','missing','missing')",
    ] {
        assert!(
            db.execute(sql, []).is_err(),
            "retained artifact constraint accepted {sql}"
        );
    }
    assert!(
        db.execute(
            "DELETE FROM artifacts WHERE session_id=?1 AND id=?2",
            rusqlite::params![provenance[0].0, provenance[0].3]
        )
        .is_err()
    );

    let mut complete = image;
    complete.id = "complete-metadata".into();
    complete.source = ArtifactSource::UserUpload;
    complete.summary = Some(content_digest(&bytes));
    complete.name = format!("{}.gif", "metadata".repeat(2400));
    log.commit_artifact(complete.clone(), bytes.clone())
        .await
        .unwrap();
    assert_eq!(
        log.get_artifact("original", "complete-metadata")
            .await
            .unwrap()
            .record
            .unwrap(),
        complete
    );
    assert_eq!(
        log.read_artifact_chunk("original", "complete-metadata", 0, 32 * 1024)
            .await
            .unwrap()
            .unwrap()
            .bytes,
        bytes
    );
    drop(db);
    log.close().await.unwrap();
}

#[path = "material_session.rs"]
mod material_session;

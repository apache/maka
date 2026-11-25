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

//! Migration 60 companion data pass: rebuild Recall rows, external segment metadata,
//! and FTS5 postings using the v60 deduplicated indexing rules while preserving pre-v60
//! Memory-evidenced conversation rows verbatim and preserving fork/imported session heads.

use super::index::{self, MessageLayout, RebuildState, load_legacy_evidenced};
use maka_agent_facts::durable::RunOwner;
use maka_event_log::StoreError;
use rusqlite::Connection;

pub(crate) fn run(c: &Connection) -> Result<(), StoreError> {
    let has_work: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_recall_messages)
             OR EXISTS(SELECT 1 FROM agent_recall_heads)
             OR EXISTS(SELECT 1 FROM agent_recall_gaps)",
        [],
        |r| r.get(0),
    )?;
    if !has_work {
        return Ok(());
    }

    let legacy_evidenced = load_legacy_evidenced(c)?;
    let sessions: Vec<(String, String)> = c
        .prepare_cached(
            "SELECT owner, session FROM agent_recall_messages
             UNION
             SELECT owner, session FROM agent_recall_heads
             UNION
             SELECT owner, session FROM agent_recall_gaps
             ORDER BY 1, 2",
        )?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;

    c.execute_batch(
        "DELETE FROM agent_recall_terms;
         DELETE FROM agent_recall_messages;
         DELETE FROM agent_recall_heads;
         DELETE FROM agent_recall_gaps;
         DELETE FROM agent_recall_external_segments;",
    )?;

    let active_evidenced = index::load_active_evidenced(c)?;
    let mut state = RebuildState::new_deferred_fts(legacy_evidenced, active_evidenced);
    for (owner_json, session) in sessions {
        let owner: RunOwner = serde_json::from_str(&owner_json)?;
        state.reset_session();
        index::rebuild_session_rows(
            c,
            &owner,
            &owner_json,
            &session,
            MessageLayout::LegacyV58OwnerSession,
            Some(&mut state),
        )?;
    }

    index::populate_all_fts_terms(c)?;
    c.execute(
        "INSERT INTO agent_recall_terms(agent_recall_terms) VALUES('optimize')",
        [],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ContentBlob;
    use crate::memory::{CaptureEvidence, Scope};
    use crate::recall::{ContextWindow, ExcludedTail, Field, Find, RecallStore, SearchQuery};
    use crate::session_history::{
        HistoryCut, SessionHistory, evidence::ProjectedField, snapshot::CaptureRequest,
    };
    use maka_agent_facts::{
        artifact::ToolReturn,
        cells::{
            CellEvent, CellId, CellObservation, CellOutput, CellOwner, CellReply, CellReplyState,
            SessionPublication,
        },
        durable::{
            AcceptedResult, AgentStepLink, ContentRef, ExternalTaskId, Fact, FactId,
            ModelAttemptId, RecordedFact, RunId, RunOwner, RunSpec, SCHEMA_VERSION, StepId,
            Terminal, ToolKey, UnixMillis,
        },
        executor::Output,
        history::HistoryRowAddress,
        history_snapshot::SnapshotId,
        memory::{MemorySource, MemorySourceSelection},
        operation::{RecordedOperationReply, RecordedOperationResult, RecordedReceipt},
        tool_call::ToolSettlement,
        tool_output::{
            AcceptedToolResult, DurableToolProjection, ProjectionPart, ReturnedToolResult,
            StoredToolResult, ToolOutput,
        },
    };
    use maka_event_log::{
        RootStore,
        connection::Query,
        root::{ROOT_DATABASE, RootNamespaces, RootOwner},
    };
    use maka_plugin_core::{
        contract::Transport,
        deployment::DeploymentRef,
        operation::{
            OperationCleanup, OperationOutcome, RecoveryContract, RecoveryProtocol, RecoveryRef,
        },
    };
    use rusqlite::params;
    use serde_json::json;
    use sha2::{Digest, Sha256};
    use std::collections::{BTreeMap, BTreeSet, HashSet};
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use tokio_util::sync::CancellationToken;
    use uuid::Uuid;

    fn put_blob(db: &Connection, blob: &ContentBlob) -> i64 {
        if maka_event_log::content::has_encoding_column(db).unwrap() {
            blob.store(db).unwrap()
        } else {
            blob.store_legacy(db).unwrap()
        }
    }

    fn pin_ref(db: &Connection, run: RunId, r: &ContentRef) {
        let cid: i64 = db
            .query_row(
                "SELECT id FROM contents WHERE content_sha256=?",
                [&r.digest],
                |row| row.get(0),
            )
            .unwrap();
        db.execute(
            "INSERT OR IGNORE INTO agent_content_pins(run,content_id) VALUES(?,?)",
            params![run.to_string(), cid],
        )
        .unwrap();
    }

    fn register_session_control(db: &Connection, session: &str) {
        db.execute(
            "INSERT OR IGNORE INTO session_control(id,fingerprint,revision,created_at,updated_at,archived,configuration)
             VALUES(?,'fp',1,1,1,0,'{}')",
            [session],
        )
        .unwrap();
        db.execute(
            "INSERT OR IGNORE INTO session_creations(session_id,creation_id,fingerprint,command,ready,failure,visible)
             VALUES(?,'c_test','fp',NULL,1,NULL,1)",
            [session],
        )
        .unwrap();
    }

    fn seed_catalog_session(db: &Connection, owner: &RunOwner, session: &str, last_seq: u64) {
        let owner_json = serde_json::to_string(owner).unwrap();
        db.execute(
            "INSERT OR REPLACE INTO agent_catalog_sessions(owner,session,last_sequence,terminal_sequence) VALUES(?,?,?,0)",
            params![owner_json, session, last_seq as i64],
        )
        .unwrap();
        db.execute(
            "INSERT OR IGNORE INTO agent_catalog_runs(run,owner,session,admission_sequence)
             SELECT run, owner, session, 1 FROM agent_run_specs WHERE owner=? AND session=?",
            params![owner_json, session],
        )
        .unwrap();
    }

    fn seed_cell(
        db: &Connection,
        spec: &RunSpec,
        run: RunId,
        cell: CellId,
        step: StepId,
        attempt: ModelAttemptId,
        call: &str,
    ) {
        let req_blob = ContentBlob::json(&json!({})).unwrap();
        let req_cid = put_blob(db, &req_blob);
        db.execute(
            "INSERT OR IGNORE INTO agent_request_specs(step,run,content_id) VALUES(?,?,?)",
            params![step.to_string(), run.to_string(), req_cid],
        )
        .unwrap();
        db.execute(
            "INSERT OR IGNORE INTO agent_attempt_ids(run,attempt,step) VALUES(?,?,?)",
            params![run.to_string(), attempt.to_string(), step.to_string()],
        )
        .unwrap();
        let owner = CellOwner::Agent {
            link: AgentStepLink { run, step, attempt },
            call: call.into(),
        };
        let body = json!({ "owner": owner }).to_string();
        db.execute(
            "INSERT OR IGNORE INTO agent_cells(cell,session,run,pending,body) VALUES(?,?,?,0,?)",
            params![cell.to_string(), spec.session_id, run.to_string(), body],
        )
        .unwrap();
    }

    fn seed_run(db: &Connection, session: &str, owner: Option<RunOwner>) -> (RunId, RunSpec, u64) {
        seed_run_with(db, session, owner, crate::store::stop_tests::spec())
    }

    fn seed_run_with(
        db: &Connection,
        session: &str,
        owner: Option<RunOwner>,
        (mut spec, input_blobs): (RunSpec, Vec<ContentBlob>),
    ) -> (RunId, RunSpec, u64) {
        register_session_control(db, session);
        let run = RunId::new();
        if let Some(o) = owner {
            spec.owner = o;
        }
        spec.session_id = session.to_owned();
        spec.trigger = maka_agent_facts::durable::Trigger::Message {
            message_id: format!("msg-{run}"),
        };
        let spec_blob = ContentBlob::json(&spec).unwrap();
        let spec_cid = put_blob(db, &spec_blob);
        let owner_json = serde_json::to_string(&spec.owner).unwrap();
        db.execute(
            "INSERT INTO agent_run_specs(run,schema_version,owner,session,spec_content_id) VALUES(?,?,?,?,?)",
            params![run.to_string(), SCHEMA_VERSION, owner_json, spec.session_id, spec_cid],
        )
        .unwrap();
        pin_ref(db, run, spec_blob.reference());
        for blob in &input_blobs {
            put_blob(db, blob);
            pin_ref(db, run, blob.reference());
        }
        let mut rev = 0;
        let (admit_seq, _) = record_fact_at(
            db,
            &spec,
            run,
            &mut rev,
            10,
            Fact::RunAdmitted {
                spec: spec_blob.reference().clone(),
            },
            false,
        );
        for blob in &input_blobs {
            let cid: i64 = db
                .query_row(
                    "SELECT id FROM contents WHERE content_sha256=?",
                    [&blob.reference().digest],
                    |r| r.get(0),
                )
                .unwrap();
            db.execute(
                "INSERT OR IGNORE INTO agent_history_content_refs(run,content_id,first_sequence) VALUES(?,?,?)",
                params![run.to_string(), cid, admit_seq as i64],
            )
            .unwrap();
        }
        (run, spec, rev)
    }

    fn record_fact_at(
        db: &Connection,
        spec: &RunSpec,
        run: RunId,
        revision: &mut u64,
        at: i64,
        fact: Fact,
        legacy_v59: bool,
    ) -> (u64, RecordedFact) {
        *revision += 1;
        let recorded = RecordedFact {
            schema_version: SCHEMA_VERSION,
            id: FactId::new(),
            run,
            revision: *revision,
            at: UnixMillis(at),
            fact,
        };
        let blob = ContentBlob::json(&recorded).unwrap();
        let cid = put_blob(db, &blob);
        db.execute(
            "INSERT INTO agent_facts(id,run,revision,schema_version,at,body_content_id) VALUES(?,?,?,?,?,?)",
            params![
                recorded.id.to_string(),
                run.to_string(),
                *revision as i64,
                SCHEMA_VERSION,
                recorded.at.0,
                cid
            ],
        )
        .unwrap();
        let seq = db.last_insert_rowid() as u64;
        db.execute(
            "INSERT OR IGNORE INTO agent_content_pins(run,content_id) VALUES(?,?)",
            params![run.to_string(), cid],
        )
        .unwrap();
        db.execute(
            "INSERT OR IGNORE INTO agent_history_content_refs(run,content_id,first_sequence) VALUES(?,?,?)",
            params![run.to_string(), cid, seq as i64],
        )
        .unwrap();
        if let Fact::ExternalEffect { event } = &recorded.fact {
            crate::external_effects::replay(db, run, *revision, event).unwrap();
        }
        let has_namespace_id: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('agent_session_history') WHERE name='namespace_id')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        if has_namespace_id {
            crate::session_history::index(db, &recorded).unwrap();
            if !matches!(
                recorded.fact,
                Fact::StepPrepared { .. } | Fact::ExternalEffect { .. }
            ) {
                crate::session_history::index_retained(db, &recorded).unwrap();
            }
            index::index_fact(db, spec, &recorded, seq).unwrap();
        } else {
            crate::session_history::index_legacy_owner_session(db, &recorded).unwrap();
            let mut single = HashSet::new();
            if legacy_v59 {
                single.insert(recorded.id.to_string());
            }
            let mut st = RebuildState::new(single, HashSet::new());
            index::index_fact_with_state(
                db,
                spec,
                &recorded,
                seq,
                Some(blob.reference().clone()),
                MessageLayout::LegacyV58OwnerSession,
                Some(&mut st),
            )
            .unwrap();
        }
        (seq, recorded)
    }

    fn seed_memory_evidence(
        db: &Connection,
        owner: &RunOwner,
        session: &str,
        fact_id: FactId,
        seq: u64,
        body: &str,
        span: std::ops::Range<usize>,
        disposition: &str,
    ) -> (String, String) {
        let (start, end) = (span.start, span.end);
        let owner_json = serde_json::to_string(owner).unwrap();
        let mem_id = Uuid::new_v4().to_string();
        let quote = body[start..end].to_owned();
        let fingerprint = hex::encode(Sha256::digest(body.as_bytes()));
        let user_src = serde_json::to_string(&MemorySource::UserOperation {
            operation_id: Uuid::new_v4(),
            observed_at: 0,
        })
        .unwrap();
        let conv_src = json!({
            "kind": "conversation",
            "reference": {
                "sessionId": session,
                "sequence": seq,
                "factId": fact_id.to_string(),
                "itemIndex": 0,
                "start": start,
                "end": end,
                "quote": quote,
                "fingerprint": fingerprint
            }
        })
        .to_string();
        let status = if disposition == "suppressed" {
            "suppressed"
        } else {
            "active"
        };
        db.execute(
            "INSERT INTO agent_memories VALUES(?1,'personal',?2,1,1,'user_recall',?3,0,0)",
            params![owner_json, mem_id, status],
        )
        .unwrap();
        db.execute(
            "INSERT INTO agent_memory_versions(namespace,scope,id,revision,body,source,digest,disposition)
             VALUES(?1,'personal',?2,1,?3,?4,'digest',?5)",
            params![owner_json, mem_id, quote, user_src, disposition],
        )
        .unwrap();
        db.execute(
            "INSERT INTO agent_memory_evidence(namespace,scope,id,assertion,source,source_key)
             VALUES(?1,'personal',?2,1,?3,?4)",
            params![owner_json, mem_id, conv_src, format!("ev-{mem_id}")],
        )
        .unwrap();
        (quote, fingerprint)
    }

    fn recovery_ref(spec: &RunSpec, op: Uuid) -> RecoveryRef {
        let digest = format!("sha256-{}", "a".repeat(64));
        RecoveryRef {
            source: DeploymentRef {
                state_domain: "b".repeat(64),
                deployment: spec.owner.deployment,
                revision: 1,
            },
            namespace: spec.owner.namespace.clone(),
            export: "workspace".into(),
            method: "read".into(),
            operation: op,
            fingerprint: digest.clone(),
            contract: RecoveryContract {
                name: "maka.workspace.Read".into(),
                version: 1,
                transport: Transport::Remote,
                digest,
            },
            recovery: RecoveryProtocol::JournalV1,
        }
    }

    async fn open_test_root(base: &Path, through: i64) -> (RootStore, crate::Store, PathBuf) {
        let namespaces = RootNamespaces {
            ownership: base.join("owners"),
            control: base.join("control"),
        };
        let root_dir = base.join("root");
        let owner = Arc::new(if root_dir.exists() {
            RootOwner::open_existing(&root_dir, &namespaces).unwrap()
        } else {
            RootOwner::create(&root_dir, &namespaces).unwrap()
        });
        let db_path = owner.canonical_path().join(ROOT_DATABASE);
        let migrations: Vec<_> = maka_event_log::ROOT_MIGRATIONS
            .iter()
            .chain(crate::MIGRATIONS)
            .filter(|m| m.version <= through)
            .copied()
            .collect();
        let root = RootStore::open(owner, &migrations).await.unwrap();
        let data = root.data_writer().unwrap();
        let store =
            crate::Store::new(data.clone(), crate::DriverDomain::new(data).unwrap()).unwrap();
        (root, store, db_path)
    }

    fn open_raw_db(path: &Path) -> Connection {
        let db = Connection::open(path).unwrap();
        maka_event_log::content::register_sql_functions(&db).unwrap();
        crate::memory::recall::configure_writer(&db).unwrap();
        db
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "test helper builds a full Cell -> LocalToolReturned -> ToolResultAccepted sequence"
    )]
    fn record_cell_cycle(
        db: &Connection,
        spec: &RunSpec,
        run: RunId,
        rev: &mut u64,
        at: i64,
        call_id: &str,
        cell_text: &str,
        cell_result: serde_json::Value,
        outer_projection: DurableToolProjection,
        legacy_v59: bool,
    ) -> (u64, FactId, u64, FactId, u64, FactId) {
        let cell = CellId::new();
        let step = StepId::new();
        let attempt = ModelAttemptId::new();
        seed_cell(db, spec, run, cell, step, attempt, call_id);
        let obs = CellObservation::Completed {
            cell_id: cell,
            content: vec![CellOutput::Text {
                text: cell_text.into(),
            }],
            result: cell_result,
        };
        let obs_blob = ContentBlob::json(&obs).unwrap();
        put_blob(db, &obs_blob);
        pin_ref(db, run, obs_blob.reference());
        let (comp_seq, comp_fact) = record_fact_at(
            db,
            spec,
            run,
            rev,
            at,
            Fact::Cell {
                event: CellEvent::Completed {
                    cell,
                    result: obs_blob.reference().clone(),
                    publication: SessionPublication {
                        values: BTreeMap::new(),
                        loaded_tools: None,
                    },
                },
            },
            legacy_v59,
        );
        let tool = ToolKey {
            attempt,
            call: call_id.into(),
        };
        let ret = ToolReturn {
            schema_version: SCHEMA_VERSION,
            artifacts: vec![],
            body: StoredToolResult::Inline(Box::new(ReturnedToolResult {
                output: ToolOutput::Cell(Box::new(CellReply {
                    cell,
                    state: CellReplyState::Completed {
                        result: obs_blob.reference().clone(),
                    },
                    observation: json!({}),
                })),
                projection: outer_projection,
                is_error: false,
                loaded_tools: BTreeSet::new(),
                display_budget_chars: None,
            })),
        };
        let ret_blob = ContentBlob::json(&ret).unwrap();
        put_blob(db, &ret_blob);
        pin_ref(db, run, ret_blob.reference());
        let (loc_seq, loc_fact) = record_fact_at(
            db,
            spec,
            run,
            rev,
            at + 1,
            Fact::LocalToolReturned {
                tool: tool.clone(),
                settlement: ToolSettlement::Returned,
                result: ret_blob.reference().clone(),
                is_error: false,
                cell_observation: None,
            },
            legacy_v59,
        );
        let acc = AcceptedToolResult::Local {
            result: ret_blob.reference().clone(),
        };
        let acc_blob = ContentBlob::json(&acc).unwrap();
        put_blob(db, &acc_blob);
        pin_ref(db, run, acc_blob.reference());
        let (acc_seq, acc_fact) = record_fact_at(
            db,
            spec,
            run,
            rev,
            at + 2,
            Fact::ToolResultAccepted {
                tool,
                result: acc_blob.reference().clone(),
                outcome: AcceptedResult::Succeeded,
            },
            legacy_v59,
        );
        (
            comp_seq,
            comp_fact.id,
            loc_seq,
            loc_fact.id,
            acc_seq,
            acc_fact.id,
        )
    }

    fn ext_delta(task: ExternalTaskId, index: u64, message_id: &str, text: &str) -> Fact {
        Fact::ExternalTaskObserved {
            task,
            index,
            model_time_ms: None,
            output: Output::OutputDelta {
                message_id: message_id.into(),
                text: text.into(),
            },
        }
    }

    fn ext_end(task: ExternalTaskId, index: u64, message_id: &str) -> Fact {
        Fact::ExternalTaskObserved {
            task,
            index,
            model_time_ms: None,
            output: Output::MessageEnd {
                message_id: message_id.into(),
            },
        }
    }

    #[tokio::test]
    async fn v60_upgrade_dedups_preserves_evidence_and_fork_heads() {
        let dir = tempfile::tempdir().unwrap();
        let (root_v59, _store_v59, db_path) = open_test_root(dir.path(), 60).await;
        drop(_store_v59);
        root_v59.close().await.unwrap();

        let (
            owner,
            evidenced_delta_seq,
            evidenced_delta_quote,
            normal_comp_seq,
            normal_loc_seq,
            normal_acc_seq,
            trunc_comp_seq,
            fail_comp_seq,
            evidenced_loc_seq,
            child_obs_seq,
            fork_expected_head,
        ) = {
            let db = open_raw_db(&db_path);
            let (run, spec, mut rev) = seed_run(&db, "s-upgrade", None);
            let owner = spec.owner.clone();
            let task = ExternalTaskId::new();

            record_fact_at(
                &db,
                &spec,
                run,
                &mut rev,
                100,
                ext_delta(task, 0, "m1", "delta-zero "),
                true,
            );
            record_fact_at(
                &db,
                &spec,
                run,
                &mut rev,
                101,
                ext_delta(task, 1, "m1", "delta-one "),
                true,
            );
            let (ev_seq, ev_fact) = record_fact_at(
                &db,
                &spec,
                run,
                &mut rev,
                102,
                ext_delta(task, 2, "m1", "pinned-delta-quote"),
                true,
            );
            let (ev_quote, _) = seed_memory_evidence(
                &db,
                &owner,
                "s-upgrade",
                ev_fact.id,
                ev_seq,
                "pinned-delta-quote",
                7..12,
                "current",
            );
            record_fact_at(
                &db,
                &spec,
                run,
                &mut rev,
                103,
                ext_delta(task, 3, "m1", "post-a "),
                true,
            );
            record_fact_at(
                &db,
                &spec,
                run,
                &mut rev,
                104,
                ext_delta(task, 4, "m1", "post-b"),
                true,
            );
            record_fact_at(&db, &spec, run, &mut rev, 105, ext_end(task, 5, "m1"), true);

            // 1. Normal covered Cell -> LocalToolReturned -> ToolResultAccepted::Local
            let (normal_comp, _, normal_loc, _, normal_acc, _) = record_cell_cycle(
                &db,
                &spec,
                run,
                &mut rev,
                200,
                "call-normal",
                "full-normal-cell-payload",
                json!({"ok": true, "toolCalls": [{"name": "Shell"}]}),
                DurableToolProjection::Content {
                    parts: vec![
                        ProjectionPart::Text {
                            text: r#"{"state":"completed","result":{"ok":true,"toolCalls":[{"name":"Shell"}]}}"#
                                .into(),
                        },
                        ProjectionPart::Text {
                            text: "full-normal-cell-payload".into(),
                        },
                    ],
                },
                true,
            );
            // 2. Truncated projection keeps CellEvent::Completed indexed
            let (trunc_comp, _, _, _, _, _) = record_cell_cycle(
                &db,
                &spec,
                run,
                &mut rev,
                210,
                "call-trunc",
                "head-unique-token-omitted-by-display-from\ntail-visible",
                json!(null),
                DurableToolProjection::Text {
                    text: "tail-visible".into(),
                },
                true,
            );
            // 3. Failure projection keeps CellEvent::Completed indexed
            let (fail_comp, _, _, _, _, _) = record_cell_cycle(
                &db,
                &spec,
                run,
                &mut rev,
                220,
                "call-fail",
                "failure-kept-cell-output",
                json!(null),
                DurableToolProjection::Failure,
                true,
            );
            // 4. Evidenced LocalToolReturned stays intact
            let (_, _, ev_loc, ev_loc_fact, _, _) = record_cell_cycle(
                &db,
                &spec,
                run,
                &mut rev,
                230,
                "call-ev-loc",
                "evidenced-local-return-body",
                json!(null),
                DurableToolProjection::Text {
                    text: "evidenced-local-return-body".into(),
                },
                true,
            );
            seed_memory_evidence(
                &db,
                &owner,
                "s-upgrade",
                ev_loc_fact,
                ev_loc,
                "evidenced-local-return-body",
                0..9,
                "current",
            );
            // 5. Ref-backed ChildObserved strips giant receipt payload
            let op_payload = ContentBlob::json(&RecordedOperationResult::Success {
                value: json!({"huge": "x".repeat(4096)}),
            })
            .unwrap();
            put_blob(&db, &op_payload);
            pin_ref(&db, run, op_payload.reference());
            let op_id = Uuid::new_v4();
            let op_reply = RecordedOperationReply {
                reference: recovery_ref(&spec, op_id),
                receipt: RecordedReceipt::Recorded {
                    outcome: OperationOutcome::Returned {
                        result: RecordedOperationResult::Referenced {
                            content: op_payload.reference().clone(),
                            is_error: false,
                        },
                    },
                    cleanup: OperationCleanup::Confirmed,
                },
            };
            let cell = CellId::new();
            seed_cell(
                &db,
                &spec,
                run,
                cell,
                StepId::new(),
                ModelAttemptId::new(),
                "call-child",
            );
            let (child_obs_seq, _) = record_fact_at(
                &db,
                &spec,
                run,
                &mut rev,
                240,
                Fact::Cell {
                    event: CellEvent::ChildObserved {
                        cell,
                        operation: op_id,
                        reply: op_reply,
                    },
                },
                true,
            );

            // Session B: forked/imported session with ONLY agent_recall_heads (0 messages rows).
            let (fork_run, fork_spec, mut fork_rev) =
                seed_run(&db, "s-fork-only", Some(owner.clone()));
            let _ = record_fact_at(
                &db,
                &fork_spec,
                fork_run,
                &mut fork_rev,
                300,
                Fact::RunTerminated {
                    terminal: Terminal::Completed,
                    diagnostic: None,
                },
                true,
            );
            let owner_json = serde_json::to_string(&owner).unwrap();
            db.execute(
                "DELETE FROM agent_recall_terms WHERE rowid IN (SELECT id FROM agent_recall_messages WHERE owner=? AND session='s-fork-only')",
                [&owner_json],
            )
            .unwrap();
            db.execute(
                "DELETE FROM agent_recall_messages WHERE owner=? AND session='s-fork-only'",
                [&owner_json],
            )
            .unwrap();
            let fork_head: (i64, String) = db
                .query_row(
                    "SELECT sequence, digest FROM agent_recall_heads WHERE owner=? AND session='s-fork-only'",
                    [&owner_json],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();

            (
                owner,
                ev_seq,
                ev_quote,
                normal_comp,
                normal_loc,
                normal_acc,
                trunc_comp,
                fail_comp,
                ev_loc,
                child_obs_seq,
                fork_head,
            )
        };

        // Upgrade cold from v60 -> v61
        let (root_v60, _store_v60, _) = open_test_root(dir.path(), 61).await;
        drop(_store_v60);
        root_v60.close().await.unwrap();

        let db = open_raw_db(&db_path);
        let owner_json = serde_json::to_string(&owner).unwrap();

        let ev_body: String = db
            .query_row(
                "SELECT body FROM agent_recall_messages WHERE owner=? AND session='s-upgrade' AND sequence=?",
                params![owner_json, evidenced_delta_seq as i64],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(&ev_body[7..12], evidenced_delta_quote);

        let sealed_segments: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM agent_recall_external_segments WHERE owner=? AND session='s-upgrade' AND sealed=1",
                [&owner_json],
                |r| r.get(0),
            )
            .unwrap();
        assert!(sealed_segments >= 1);

        let (loc_body, loc_ref_seq, loc_ref_start): (String, Option<i64>, Option<i64>) = db
            .query_row(
                "SELECT body, body_ref_sequence, body_ref_start FROM agent_recall_messages WHERE owner=? AND session='s-upgrade' AND sequence=?",
                params![owner_json, normal_loc_seq as i64],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert!(loc_body.is_empty());
        assert_eq!(loc_ref_seq, Some(normal_acc_seq as i64));
        assert_eq!(loc_ref_start, Some(0));

        let (comp_body, comp_ref_seq): (String, Option<i64>) = db
            .query_row(
                "SELECT body, body_ref_sequence FROM agent_recall_messages WHERE owner=? AND session='s-upgrade' AND sequence=?",
                params![owner_json, normal_comp_seq as i64],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(comp_body.is_empty());
        assert_eq!(comp_ref_seq, Some(normal_acc_seq as i64));

        for kept_seq in [trunc_comp_seq, fail_comp_seq, evidenced_loc_seq] {
            let (body, ref_seq): (String, Option<i64>) = db
                .query_row(
                    "SELECT body, body_ref_sequence FROM agent_recall_messages WHERE owner=? AND session='s-upgrade' AND sequence=?",
                    params![owner_json, kept_seq as i64],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert!(!body.is_empty(), "row {kept_seq} must stay indexed");
            assert_eq!(ref_seq, None);
        }

        let child_body: String = db
            .query_row(
                "SELECT body FROM agent_recall_messages WHERE owner=? AND session='s-upgrade' AND sequence=?",
                params![owner_json, child_obs_seq as i64],
                |r| r.get(0),
            )
            .unwrap();
        assert!(child_body.contains("maka.workspace.Read"));
        assert!(child_body.len() < 128);

        let fork_head_after: (i64, String) = db
            .query_row(
                "SELECT sequence, digest FROM agent_recall_heads WHERE owner=? AND session='s-fork-only'",
                [&owner_json],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(fork_head_after, fork_expected_head);
    }

    #[tokio::test]
    async fn fixed_mid_cut_finds_superseded_cell_completed_and_local_return_with_budget_and_masking()
     {
        let dir = tempfile::tempdir().unwrap();
        let (root, _store, db_path) = open_test_root(dir.path(), i64::MAX).await;

        let (owner, turn_id, comp_seq, comp_fact, loc_seq, loc_fact, acc_seq, acc_fact, admit_seq) = {
            let db = open_raw_db(&db_path);
            let (run, spec, mut rev) = seed_run(&db, "s-midcut", None);
            let owner = spec.owner.clone();
            let admit_seq: u64 = db
                .query_row(
                    "SELECT MIN(h.sequence) FROM agent_session_history h JOIN agent_namespaces ns ON ns.id=h.namespace_id WHERE ns.session='s-midcut'",
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap() as u64;
            let (comp_seq, comp_fact, loc_seq, loc_fact, acc_seq, acc_fact) = record_cell_cycle(
                &db,
                &spec,
                run,
                &mut rev,
                1000,
                "call-mid",
                "alpha-midcut-cell-needle",
                json!({"ok": true, "toolCalls": [{"name": "Read"}]}),
                DurableToolProjection::Content {
                    parts: vec![
                        ProjectionPart::Text {
                            text: r#"{"state":"completed","result":{"ok":true,"toolCalls":[{"name":"Read"}]}}"#
                                .into(),
                        },
                        ProjectionPart::Text {
                            text: "alpha-midcut-cell-needle".into(),
                        },
                    ],
                },
                false,
            );
            seed_catalog_session(&db, &owner, "s-midcut", acc_seq);
            (
                owner,
                spec.turn_id,
                comp_seq,
                comp_fact,
                loc_seq,
                loc_fact,
                acc_seq,
                acc_fact,
                admit_seq,
            )
        };

        let writer = root.data_writer().unwrap();
        let history = SessionHistory::new(writer.clone(), owner.clone(), "s-midcut".into());
        let recall = RecallStore::new(writer.clone(), owner.clone(), "s-".into()).unwrap();
        let stop = CancellationToken::new();

        // 1. Cut right after CellEvent::Completed (before LocalToolReturned & ToolResultAccepted)
        let cut_cell = recall
            .capture("s-midcut".into(), Some(comp_seq))
            .await
            .unwrap();
        let found_fts = recall
            .find_page(
                cut_cell.clone(),
                Find {
                    after: None,
                    query: "alpha-midcut-cell-needle".into(),
                    case_sensitive: false,
                    whole_word: false,
                    include_internal: false,
                },
                stop.clone(),
            )
            .await
            .unwrap();
        assert_eq!(found_fts.matches.len(), 1);
        assert_eq!(found_fts.matches[0].position.source_sequence, comp_seq);

        let found_scan = recall
            .find_page(
                cut_cell.clone(),
                Find {
                    after: Some(crate::recall::RowPosition {
                        source_sequence: admit_seq,
                        item_index: 0,
                    }),
                    query: "alpha-midcut-cell-needle".into(),
                    case_sensitive: false,
                    whole_word: false,
                    include_internal: false,
                },
                stop.clone(),
            )
            .await
            .unwrap();
        assert_eq!(found_scan.matches.len(), 1);
        assert_eq!(found_scan.matches[0].position.source_sequence, comp_seq);

        let excl_cell = recall
            .search(
                SearchQuery {
                    terms: vec!["alpha-midcut-cell-needle".into()],
                    session_id: Some("s-midcut".into()),
                    since: None,
                    until: None,
                    limit: Some(10),
                    transcript_only: false,
                    exclude: Some(ExcludedTail {
                        session_id: "s-midcut".into(),
                        turn_id: turn_id.clone(),
                        covered_through: comp_seq,
                    }),
                },
                0,
                0,
                stop.clone(),
            )
            .await
            .unwrap();
        assert_eq!(excl_cell.hits.len(), 1);
        assert_eq!(excl_cell.hits[0].anchor.position.source_sequence, comp_seq);

        // 2. Cut between LocalToolReturned and ToolResultAccepted::Local
        let cut_local = recall
            .capture("s-midcut".into(), Some(loc_seq))
            .await
            .unwrap();
        let found_local = recall
            .find_page(
                cut_local.clone(),
                Find {
                    after: None,
                    query: "alpha-midcut-cell-needle".into(),
                    case_sensitive: false,
                    whole_word: false,
                    include_internal: false,
                },
                stop.clone(),
            )
            .await
            .unwrap();
        assert!(
            found_local
                .matches
                .iter()
                .any(|m| m.position.source_sequence == loc_seq)
        );

        let full_loc_body = r#"{"state":"completed","result":{"ok":true,"toolCalls":[{"name":"Read"}]}}
alpha-midcut-cell-needle"#;
        let expected_offset = full_loc_body.find("alpha-midcut-cell-needle").unwrap() as u64;
        let loc_addr = HistoryRowAddress::Live {
            sequence: loc_seq,
            fact: loc_fact,
            item_index: 0,
        };
        let excerpt = ProjectedField::Last(Field::Result)
            .excerpt(
                &loc_addr,
                expected_offset,
                full_loc_body.len() as u64,
                "alpha-midcut-cell-needle",
            )
            .unwrap();
        let offsets = history.excerpt_offsets(vec![excerpt]).await.unwrap();
        assert_eq!(offsets.get(&loc_addr), Some(&0));

        let captured = writer
            .query(CaptureEvidence {
                scope: Scope {
                    namespace: serde_json::to_string(&owner).unwrap(),
                    location: "personal".into(),
                    binding: None,
                },
                selection: MemorySourceSelection {
                    session_id: "s-midcut".into(),
                    sequence: loc_seq,
                    item_index: 0,
                    start: expected_offset as u32,
                    end: (expected_offset + "alpha-midcut-cell-needle".len() as u64) as u32,
                    quote: "alpha-midcut-cell-needle".into(),
                },
            })
            .await
            .unwrap();
        assert_eq!(captured.quote, "alpha-midcut-cell-needle");

        // 3. Latest cut after ToolResultAccepted::Local matches ONLY acc_seq (no duplicate hits)
        let cut_acc = recall
            .capture("s-midcut".into(), Some(acc_seq))
            .await
            .unwrap();
        let found_acc = recall
            .find_page(
                cut_acc,
                Find {
                    after: None,
                    query: "alpha-midcut-cell-needle".into(),
                    case_sensitive: false,
                    whole_word: false,
                    include_internal: false,
                },
                stop.clone(),
            )
            .await
            .unwrap();
        assert_eq!(found_acc.matches.len(), 1);
        assert_eq!(found_acc.matches[0].position.source_sequence, acc_seq);

        // 4. Memory suppression on acc_fact masks cleared LocalToolReturned on cut_local,
        // and suppression on comp_fact masks CellEvent::Completed on cut_cell.
        {
            let db = open_raw_db(&db_path);
            let start = expected_offset as usize;
            let end = start + "alpha-midcut-cell-needle".len();
            seed_memory_evidence(
                &db,
                &owner,
                "s-midcut",
                acc_fact,
                acc_seq,
                full_loc_body,
                start..end,
                "suppressed",
            );
            let comp_body = "alpha-midcut-cell-needle\nRead";
            seed_memory_evidence(
                &db,
                &owner,
                "s-midcut",
                comp_fact,
                comp_seq,
                comp_body,
                0.."alpha-midcut-cell-needle".len(),
                "suppressed",
            );
        }
        let owner_key = serde_json::to_string(&owner).unwrap();
        let masked_local = writer
            .query(MaskedFindCheck {
                owner: owner.clone(),
                owner_key: owner_key.clone(),
                cut: cut_local,
                query: "alpha-midcut-cell-needle".into(),
            })
            .await
            .unwrap();
        assert!(masked_local.matches.is_empty());

        let masked_cell = writer
            .query(MaskedFindCheck {
                owner: owner.clone(),
                owner_key,
                cut: cut_cell,
                query: "alpha-midcut-cell-needle".into(),
            })
            .await
            .unwrap();
        assert!(masked_cell.matches.is_empty());

        drop(recall);
        drop(history);
        drop(_store);
        root.close().await.unwrap();
    }

    struct MaskedFindCheck {
        owner: RunOwner,
        owner_key: String,
        cut: HistoryCut,
        query: String,
    }
    impl Query for MaskedFindCheck {
        type Output = crate::recall::FindPage;
        fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
            let mut work = crate::recall::find::FindWork::default();
            let stop = CancellationToken::new();
            crate::recall::find::find_index(
                c,
                &self.owner_key,
                &self.cut,
                Find {
                    after: None,
                    query: self.query,
                    case_sensitive: false,
                    whole_word: false,
                    include_internal: false,
                },
                &stop,
                0,
                Some(&self.owner),
                &mut work,
            )
            .map(|(page, _)| page)
        }
    }

    #[tokio::test]
    async fn external_segments_live_streaming_time_window_and_rebuild_parity() {
        let dir = tempfile::tempdir().unwrap();
        let (root, _store, db_path) = open_test_root(dir.path(), i64::MAX).await;

        let (owner, run, spec, mut rev, d1_seq, d1_fact, d2_seq, d2_fact, u2_seq, live_tail_fact) = {
            let db = open_raw_db(&db_path);
            let (run, spec, mut rev) = seed_run_with(
                &db,
                "s-ext",
                None,
                crate::store::stop_tests::external_spec(),
            );
            let owner = spec.owner.clone();
            let task = ExternalTaskId::new();
            let task_blob = ContentBlob::json(&maka_agent_facts::executor::TaskDescriptor {
                protocol: maka_agent_facts::executor::NATIVE_TASK_PROTOCOL.into(),
                source: maka_agent_facts::executor::Binding {
                    executor_id: "external".to_string().try_into().unwrap(),
                    package_id: "maka.agent".into(),
                    entry_id: "maka.agent".into(),
                    activation: "fixture".into(),
                },
                payload: json!({}),
            })
            .unwrap();
            put_blob(&db, &task_blob);
            pin_ref(&db, run, task_blob.reference());
            record_fact_at(
                &db,
                &spec,
                run,
                &mut rev,
                900,
                Fact::ExternalTaskPrepared {
                    task,
                    descriptor: task_blob.reference().clone(),
                    live_workspace: false,
                },
                false,
            );
            record_fact_at(
                &db,
                &spec,
                run,
                &mut rev,
                950,
                Fact::ExternalTaskAdmitted { task },
                false,
            );

            // Segment 1 (sealed by MessageEnd): s0@1000, d1@2000, d2@4000
            record_fact_at(
                &db,
                &spec,
                run,
                &mut rev,
                1000,
                ext_delta(task, 0, "seg1", "seg1-head "),
                false,
            );
            let (d1_seq, d1_fact) = record_fact_at(
                &db,
                &spec,
                run,
                &mut rev,
                2000,
                ext_delta(task, 1, "seg1", "early-alpha-window "),
                false,
            );
            let (d2_seq, d2_fact) = record_fact_at(
                &db,
                &spec,
                run,
                &mut rev,
                4000,
                ext_delta(task, 2, "seg1", "late-beta-window"),
                false,
            );
            record_fact_at(
                &db,
                &spec,
                run,
                &mut rev,
                4001,
                ext_end(task, 3, "seg1"),
                false,
            );

            // Segment 2 (still actively streaming, unsealed): u0@5000, u1@6000, u2@7000
            record_fact_at(
                &db,
                &spec,
                run,
                &mut rev,
                5000,
                ext_delta(task, 4, "seg2", "live-head "),
                false,
            );
            record_fact_at(
                &db,
                &spec,
                run,
                &mut rev,
                6000,
                ext_delta(task, 5, "seg2", "live-gamma-"),
                false,
            );
            let (u2_seq, u2_fact) = record_fact_at(
                &db,
                &spec,
                run,
                &mut rev,
                7000,
                ext_delta(task, 6, "seg2", "tail-needle"),
                false,
            );
            seed_catalog_session(&db, &owner, "s-ext", u2_seq);
            (
                owner, run, spec, rev, d1_seq, d1_fact.id, d2_seq, d2_fact.id, u2_seq, u2_fact.id,
            )
        };

        let writer = root.data_writer().unwrap();
        let recall = RecallStore::new(writer, owner.clone(), "s-".into()).unwrap();
        let stop = CancellationToken::new();

        // 1. Coalesced sealed segment respects per-delta until / since boundaries
        let until_early = recall
            .search(
                SearchQuery {
                    terms: vec!["early-alpha-window".into()],
                    session_id: Some("s-ext".into()),
                    since: None,
                    until: Some(3000),
                    limit: Some(10),
                    transcript_only: false,
                    exclude: None,
                },
                0,
                0,
                stop.clone(),
            )
            .await
            .unwrap();
        assert_eq!(until_early.hits.len(), 1);
        assert_eq!(until_early.hits[0].anchor.timestamp, 2000);

        let until_excludes_late = recall
            .search(
                SearchQuery {
                    terms: vec!["late-beta-window".into()],
                    session_id: Some("s-ext".into()),
                    since: None,
                    until: Some(3000),
                    limit: Some(10),
                    transcript_only: false,
                    exclude: None,
                },
                0,
                0,
                stop.clone(),
            )
            .await
            .unwrap();
        assert!(until_excludes_late.hits.is_empty());

        let since_excludes_early = recall
            .search(
                SearchQuery {
                    terms: vec!["early-alpha-window".into()],
                    session_id: Some("s-ext".into()),
                    since: Some(3000),
                    until: None,
                    limit: Some(10),
                    transcript_only: false,
                    exclude: None,
                },
                0,
                0,
                stop.clone(),
            )
            .await
            .unwrap();
        assert!(since_excludes_early.hits.is_empty());

        let since_late = recall
            .search(
                SearchQuery {
                    terms: vec!["late-beta-window".into()],
                    session_id: Some("s-ext".into()),
                    since: Some(3000),
                    until: None,
                    limit: Some(10),
                    transcript_only: false,
                    exclude: None,
                },
                0,
                0,
                stop.clone(),
            )
            .await
            .unwrap();
        assert_eq!(since_late.hits.len(), 1);

        // 2. Active unsealed stream is searchable and resolvable via recall.context(anchor)
        let live_found = recall
            .search(
                SearchQuery {
                    terms: vec!["live-gamma-tail-needle".into()],
                    session_id: Some("s-ext".into()),
                    since: None,
                    until: None,
                    limit: Some(10),
                    transcript_only: false,
                    exclude: None,
                },
                0,
                0,
                stop.clone(),
            )
            .await
            .unwrap();
        assert_eq!(live_found.hits.len(), 1);
        assert_eq!(
            live_found.hits[0].anchor.message_id,
            live_tail_fact.to_string()
        );
        let ctx = recall
            .context(
                "s-ext".into(),
                live_tail_fact.to_string(),
                ContextWindow {
                    before: 2,
                    after: 2,
                },
                None,
                None,
                stop.clone(),
            )
            .await
            .unwrap();
        assert!(ctx.anchor.body.contains("live-gamma-tail-needle"));

        // Unsealed external anchor is valid for ReadPositions too.
        let live_cut = recall.capture("s-ext".into(), None).await.unwrap();
        let unsealed_anchor = maka_agent_facts::history::RowPosition {
            source_sequence: u2_seq,
            item_index: 0,
        };
        let win = recall
            .positions(
                live_cut,
                Some(unsealed_anchor),
                true,
                false,
                8,
                stop.clone(),
            )
            .await
            .unwrap();
        assert!(win.contains(&unsealed_anchor));

        // 2b. ExcludedTail covered_through mid-segment on sealed seg1 resolves in context() & neighbors().
        let excl = crate::recall::ExcludedTail {
            session_id: "s-ext".into(),
            turn_id: spec.turn_id.clone(),
            covered_through: d1_seq,
        };
        let excl_ctx = recall
            .context(
                "s-ext".into(),
                d1_fact.to_string(),
                ContextWindow {
                    before: 2,
                    after: 2,
                },
                None,
                Some(excl),
                stop.clone(),
            )
            .await
            .unwrap();
        assert!(excl_ctx.anchor.body.contains("early-alpha-window"));
        assert!(
            excl_ctx
                .messages
                .iter()
                .any(|m| m.body.contains("seg1-head")),
            "neighbors() must include preceding S0 alongside ExcludedTail anchor"
        );

        // 3. Mid-segment fixed cut right after d1 still finds early-alpha-window even after seg1 sealed
        let mid_cut = recall.capture("s-ext".into(), Some(d1_seq)).await.unwrap();
        let mid_found = recall
            .find_page(
                mid_cut.clone(),
                Find {
                    after: None,
                    query: "early-alpha-window".into(),
                    case_sensitive: false,
                    whole_word: false,
                    include_internal: false,
                },
                stop.clone(),
            )
            .await
            .unwrap();
        assert_eq!(mid_found.matches.len(), 1);
        assert_eq!(mid_found.matches[0].position.source_sequence, d1_seq);

        // 3b. Restricted Memory span on sealed S_last (d2_fact) must mask both live ExecutorViewAt
        // (against real migrated tables) and straddling historical cuts (find_page + context).
        {
            let db = open_raw_db(&db_path);
            seed_memory_evidence(
                &db,
                &owner,
                "s-ext",
                d2_fact,
                d2_seq,
                "early-alpha-window late-beta-window",
                0.."early-alpha-window".len(),
                "suppressed",
            );
        }
        let history =
            SessionHistory::new(root.data_writer().unwrap(), owner.clone(), "s-ext".into());
        let tip_cut = history.capture().await.unwrap();
        let (_, tip_tx) = crate::session_history::source_tree::HistoryDataSource::Live {
            history: history.clone(),
            cut: tip_cut,
        }
        .executor_view(run, true)
        .await
        .unwrap();
        assert_eq!(
            tip_tx.text("seg1", false).unwrap().body.to_string(),
            "seg1-head ****************** late-beta-window"
        );
        let (_, mid_tx) = crate::session_history::source_tree::HistoryDataSource::Live {
            history,
            cut: mid_cut.clone(),
        }
        .executor_view(run, true)
        .await
        .unwrap();
        assert_eq!(
            mid_tx.text("seg1", false).unwrap().body.to_string(),
            "seg1-head ****************** "
        );
        {
            let db = open_raw_db(&db_path);
            let owner_json = serde_json::to_string(&owner).unwrap();
            let mut work = crate::recall::FindWork::default();
            let (mid_redacted, _) = crate::recall::find_index(
                &db,
                &owner_json,
                &mid_cut,
                Find {
                    after: None,
                    query: "early-alpha-window".into(),
                    case_sensitive: false,
                    whole_word: false,
                    include_internal: false,
                },
                &stop,
                0,
                Some(&owner),
                &mut work,
            )
            .unwrap();
            assert!(
                mid_redacted.matches.is_empty(),
                "straddling cut must redact hidden span keyed on sealed tail_end_fact"
            );
        }
        let excl_redacted = recall
            .context(
                "s-ext".into(),
                d1_fact.to_string(),
                ContextWindow {
                    before: 1,
                    after: 1,
                },
                None,
                Some(crate::recall::ExcludedTail {
                    session_id: "s-ext".into(),
                    turn_id: spec.turn_id.clone(),
                    covered_through: d1_seq,
                }),
                stop.clone(),
            )
            .await
            .unwrap();
        assert!(
            !excl_redacted.anchor.body.contains("early-alpha-window")
                && excl_redacted.anchor.body.contains("******************"),
            "context() on straddling ExcludedTail cut must mask tail_end_fact hidden span: {}",
            excl_redacted.anchor.body
        );

        // 4. RunTerminated seals Segment 2 and rebuild reproduces identical messages + segments
        {
            let db = open_raw_db(&db_path);
            let owner_json = serde_json::to_string(&owner).unwrap();
            record_fact_at(
                &db,
                &spec,
                run,
                &mut rev,
                8000,
                Fact::RunTerminated {
                    terminal: Terminal::Completed,
                    diagnostic: None,
                },
                false,
            );
            let ns_id = crate::namespace::find_id(&db, &owner_json, "s-ext")
                .unwrap()
                .unwrap();
            let snapshot_state = |db: &Connection| {
                let msgs: Vec<(i64, String)> = db
                    .prepare(
                        "SELECT sequence, body FROM agent_recall_messages
                         WHERE namespace_id=? ORDER BY sequence, ordinal",
                    )
                    .unwrap()
                    .query_map([ns_id], |r| Ok((r.get(0)?, r.get(1)?)))
                    .unwrap()
                    .collect::<Result<_, _>>()
                    .unwrap();
                let segs: Vec<(i64, Option<i64>, Option<i64>, i64)> = db
                    .prepare(
                        "SELECT s0_sequence, tail_start_sequence, tail_end_sequence, sealed
                         FROM agent_recall_external_segments
                         WHERE namespace_id=? ORDER BY s0_sequence",
                    )
                    .unwrap()
                    .query_map([ns_id], |r| {
                        Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                    })
                    .unwrap()
                    .collect::<Result<_, _>>()
                    .unwrap();
                (msgs, segs)
            };
            // Record active v60 Memory evidence on sealed S_last (u2) and verify rebuild does
            // NOT split S_last back into single deltas.
            seed_memory_evidence(
                &db,
                &owner,
                "s-ext",
                live_tail_fact,
                u2_seq,
                "live-gamma-tail-needle",
                0..10,
                "current",
            );
            let before_rebuild = snapshot_state(&db);
            assert!(before_rebuild.1.iter().all(|s| s.3 == 1));

            let mut st = RebuildState::new(
                index::load_legacy_evidenced(&db).unwrap(),
                index::load_active_evidenced(&db).unwrap(),
            );
            index::rebuild_session(
                &db,
                &owner,
                &owner_json,
                "s-ext",
                MessageLayout::Current,
                Some(&mut st),
            )
            .unwrap();
            let after_rebuild = snapshot_state(&db);
            assert_eq!(before_rebuild, after_rebuild);
        }

        drop(recall);
        drop(_store);
        root.close().await.unwrap();
    }

    #[tokio::test]
    async fn snapshot_navigation_matches_v60_coalesced_deltas() {
        let dir = tempfile::tempdir().unwrap();
        let (root, _store, db_path) = open_test_root(dir.path(), i64::MAX).await;

        let owner = {
            let db = open_raw_db(&db_path);
            let (run, spec, mut rev) = seed_run_with(
                &db,
                "s-snap",
                None,
                crate::store::stop_tests::external_spec(),
            );
            let owner = spec.owner.clone();
            let task = ExternalTaskId::new();
            let task_blob = ContentBlob::json(&maka_agent_facts::executor::TaskDescriptor {
                protocol: maka_agent_facts::executor::NATIVE_TASK_PROTOCOL.into(),
                source: maka_agent_facts::executor::Binding {
                    executor_id: "external".to_string().try_into().unwrap(),
                    package_id: "maka.agent".into(),
                    entry_id: "maka.agent".into(),
                    activation: "fixture".into(),
                },
                payload: json!({}),
            })
            .unwrap();
            put_blob(&db, &task_blob);
            pin_ref(&db, run, task_blob.reference());
            record_fact_at(
                &db,
                &spec,
                run,
                &mut rev,
                98,
                Fact::ExternalTaskPrepared {
                    task,
                    descriptor: task_blob.reference().clone(),
                    live_workspace: false,
                },
                false,
            );
            record_fact_at(
                &db,
                &spec,
                run,
                &mut rev,
                99,
                Fact::ExternalTaskAdmitted { task },
                false,
            );
            for (i, chunk) in ["snap-part-0 ", "snap-part-1 ", "snap-part-2"]
                .into_iter()
                .enumerate()
            {
                record_fact_at(
                    &db,
                    &spec,
                    run,
                    &mut rev,
                    100 + i as i64,
                    ext_delta(task, i as u64, "sm1", chunk),
                    false,
                );
            }
            let (end_seq, _) = record_fact_at(
                &db,
                &spec,
                run,
                &mut rev,
                105,
                ext_end(task, 3, "sm1"),
                false,
            );
            seed_catalog_session(&db, &owner, "s-snap", end_seq);
            owner
        };

        let history = SessionHistory::new(root.data_writer().unwrap(), owner, "s-snap".into());
        let cut = history.capture().await.unwrap();
        let snap = history
            .capture_snapshot(
                CaptureRequest {
                    id: SnapshotId::new(),
                    cut,
                },
                CancellationToken::new(),
            )
            .await
            .unwrap();
        snap.ensure_navigation(CancellationToken::new())
            .await
            .unwrap();

        let check_db = open_raw_db(&db_path);
        let nav_chunks: Vec<String> = check_db
            .prepare(
                "SELECT c.body
                 FROM agent_history_snapshot_nav_chunks c
                 JOIN agent_history_snapshot_nav_documents d ON d.id = c.document
                 WHERE d.snapshot = ?",
            )
            .unwrap()
            .query_map([snap.id().to_string()], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let joined = nav_chunks.join("\n");
        assert!(joined.contains("snap-part-1 snap-part-2"), "{joined}");

        drop(snap);
        drop(history);
        drop(_store);
        root.close().await.unwrap();
    }
}

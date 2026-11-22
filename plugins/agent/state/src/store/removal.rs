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
//! A removed Session's agent history is released after its retirement drains.
//! Each Run is its own transaction so a crash resumes from the remaining Runs;
//! released content goes through the Root's pending content collector.
use super::*;
use rusqlite::{OptionalExtension, params};

#[derive(Clone, Copy)]
enum Step {
    Run(&'static str),
    RunOwnerSession(&'static str),
    Session(&'static str),
    OwnerSession(&'static str),
}

// Children before parents so PRAGMA foreign_keys = ON holds throughout.
// Shared run-history cleanup executed for every removed Run, including Runs
// that retain a minimal stub for profile-scoped computer grants/revocations.
const RUN_HISTORY_RELEASES: &[Step] = &[
    Step::Run(
        "INSERT OR IGNORE INTO pending_content_releases(content_id)
         SELECT body_content_id FROM agent_facts WHERE run=?1
         UNION SELECT content_id FROM agent_request_specs WHERE run=?1
         UNION SELECT content_id FROM agent_answer_parts WHERE run=?1
         UNION SELECT descriptor_content_id FROM agent_external_steering WHERE run=?1
         UNION SELECT content_id FROM agent_history_content_refs WHERE run=?1",
    ),
    Step::RunOwnerSession(
        "DELETE FROM agent_recall_terms WHERE rowid IN(SELECT id FROM agent_recall_messages
         WHERE owner=?2 AND session=?3 AND sequence IN(SELECT sequence FROM agent_facts WHERE run=?1))",
    ),
    Step::RunOwnerSession(
        "DELETE FROM agent_recall_messages WHERE owner=?2 AND session=?3
         AND sequence IN(SELECT sequence FROM agent_facts WHERE run=?1)",
    ),
    Step::Run(
        "DELETE FROM agent_session_history WHERE sequence IN(SELECT sequence FROM agent_facts WHERE run=?1)",
    ),
    Step::Run("DELETE FROM agent_history_content_refs WHERE run=?1"),
    Step::RunOwnerSession(
        "DELETE FROM agent_catalog_messages WHERE owner=?2 AND session=?3
         AND sequence IN(SELECT sequence FROM agent_facts WHERE run=?1)",
    ),
    Step::Run("DELETE FROM agent_catalog_runs WHERE run=?1"),
    Step::Run("DELETE FROM agent_cells WHERE run=?1"),
    Step::Run("DELETE FROM agent_diagnostic_coverage WHERE run=?1"),
    Step::Run("DELETE FROM agent_diagnostics WHERE run=?1"),
    Step::Run("DELETE FROM agent_external_publication_items WHERE run=?1"),
    Step::Run("DELETE FROM agent_external_publications WHERE run=?1"),
    Step::Run("DELETE FROM agent_external_effects WHERE run=?1"),
    Step::Run("DELETE FROM agent_external_steering WHERE run=?1"),
    Step::Run("DELETE FROM agent_continuation_successors WHERE run=?1 OR source_run=?1"),
    Step::Run("DELETE FROM agent_history_snapshot_adoptions WHERE run=?1"),
    Step::Run("DELETE FROM agent_artifact_run_bindings WHERE run=?1"),
    Step::Run("DELETE FROM agent_model_items WHERE run=?1"),
    Step::Run("DELETE FROM agent_computer_native_turn_fences WHERE run=?1"),
    Step::Run("DELETE FROM agent_computer_native_bindings WHERE run=?1"),
    Step::Run("DELETE FROM agent_computer_activities WHERE run=?1"),
    Step::Run("DELETE FROM agent_computer_stops WHERE run=?1"),
    Step::Run("DELETE FROM agent_computer_authorizations WHERE run=?1"),
    Step::Run("DELETE FROM agent_attempt_ids WHERE run=?1"),
    Step::Run("DELETE FROM agent_request_specs WHERE run=?1"),
    Step::Run("DELETE FROM agent_attempts WHERE run=?1"),
    Step::Run("DELETE FROM agent_steps WHERE run=?1"),
    Step::Run("DELETE FROM agent_tools WHERE run=?1"),
    Step::Run("DELETE FROM agent_approvals WHERE run=?1"),
    Step::Run("DELETE FROM agent_blockers WHERE run=?1"),
    Step::Run("DELETE FROM agent_waits WHERE run=?1"),
    Step::Run("DELETE FROM agent_operation_pins WHERE run=?1"),
    Step::Run("DELETE FROM agent_answer_parts WHERE run=?1"),
    Step::Run("DELETE FROM agent_facts WHERE run=?1"),
];

// Full Run release when no profile-scoped computer grant or revocation depends
// on this Run's canonical computer facts, interactions, or run metadata.
const RUN_FULL_TAIL: &[Step] = &[
    Step::Run(
        "INSERT OR IGNORE INTO pending_content_releases(content_id)
         SELECT content_id FROM agent_content_pins WHERE run=?1
         UNION SELECT spec_content_id FROM agent_run_specs WHERE run=?1",
    ),
    Step::Run("DELETE FROM agent_computer_subjects WHERE run=?1"),
    Step::Run("DELETE FROM agent_computer_facts WHERE run=?1"),
    Step::Run(
        "DELETE FROM agent_computer_grants
         WHERE request IN(SELECT request FROM agent_interaction_requests WHERE run=?1)",
    ),
    Step::Run(
        "DELETE FROM agent_interaction_grants
         WHERE request IN(SELECT request FROM agent_interaction_requests WHERE run=?1)",
    ),
    Step::Run(
        "DELETE FROM agent_interaction_outcomes
         WHERE request IN(SELECT request FROM agent_interaction_requests WHERE run=?1)",
    ),
    Step::Run(
        "DELETE FROM agent_interaction_pending
         WHERE request IN(SELECT request FROM agent_interaction_requests WHERE run=?1)",
    ),
    Step::Run("DELETE FROM agent_interaction_requests WHERE run=?1"),
    Step::Run("DELETE FROM agent_content_pins WHERE run=?1"),
    Step::Run("DELETE FROM agent_runs WHERE run=?1"),
    Step::Run("DELETE FROM agent_run_specs WHERE run=?1"),
];

// Profile-scoped computer grants and revocations outlive the Session that
// created them, and computer::rebuild / interactions::rebuild replay their
// canonical backing facts, outcomes, subjects, pins, and run metadata.
const RUN_PROFILE_COMPUTER_TAIL: &[Step] = &[
    Step::Run(
        "DELETE FROM agent_computer_grants WHERE scope<>'profile'
         AND request IN(SELECT request FROM agent_interaction_requests WHERE run=?1)",
    ),
    Step::Run(
        "DELETE FROM agent_interaction_grants
         WHERE request IN(SELECT request FROM agent_interaction_requests WHERE run=?1)",
    ),
    Step::Run(
        "DELETE FROM agent_interaction_pending
         WHERE request IN(SELECT request FROM agent_interaction_requests WHERE run=?1)",
    ),
    Step::Run(
        "DELETE FROM agent_interaction_outcomes
         WHERE request IN(SELECT request FROM agent_interaction_requests WHERE run=?1)
         AND NOT EXISTS(SELECT 1 FROM agent_computer_grants g WHERE g.request=agent_interaction_outcomes.request)",
    ),
    Step::Run(
        "DELETE FROM agent_interaction_requests WHERE run=?1
         AND NOT EXISTS(SELECT 1 FROM agent_computer_grants g WHERE g.request=agent_interaction_requests.request)",
    ),
];

const SESSION_RELEASES: &[Step] = &[
    Step::Session(
        "INSERT OR IGNORE INTO pending_content_releases(content_id)
         SELECT body_content_id FROM agent_queue_events WHERE session=?1
         UNION SELECT content_id FROM agent_queue_content_pins WHERE session=?1
         UNION SELECT content_id FROM agent_cell_notifications WHERE session=?1
         UNION SELECT value_content_id FROM agent_session_values WHERE session=?1",
    ),
    Step::Session("DELETE FROM agent_history_queue_requests WHERE session=?1"),
    Step::Session("DELETE FROM agent_message_submissions WHERE session=?1"),
    Step::Session("DELETE FROM agent_queue_events WHERE session=?1"),
    Step::Session("DELETE FROM agent_queue_content_pins WHERE session=?1"),
    Step::Session("DELETE FROM agent_queue_items WHERE session=?1"),
    Step::Session("DELETE FROM agent_queue_heads WHERE session=?1"),
    Step::Session("DELETE FROM agent_cell_notifications WHERE session=?1"),
    Step::Session("DELETE FROM agent_session_values WHERE session=?1"),
    Step::Session("DELETE FROM agent_session_loaded_tools WHERE session=?1"),
    Step::Session("DELETE FROM agent_interaction_capabilities WHERE session=?1"),
    Step::Session(
        "DELETE FROM agent_interaction_heads WHERE session=?1
         AND NOT EXISTS(SELECT 1 FROM agent_interaction_requests r WHERE r.session=?1)",
    ),
    Step::OwnerSession("DELETE FROM agent_recall_heads WHERE owner=?1 AND session=?2"),
    Step::OwnerSession("DELETE FROM agent_recall_gaps WHERE owner=?1 AND session=?2"),
    Step::OwnerSession("DELETE FROM agent_catalog_sessions WHERE owner=?1 AND session=?2"),
    Step::OwnerSession("DELETE FROM agent_catalog_controls WHERE owner=?1 AND session=?2"),
];

impl Store {
    /// Release the agent history of a Session whose removal fence is durable
    /// and whose live owners have drained. Repeating it after a crash resumes.
    pub async fn release_removed_session(
        &self,
        owner: RunOwner,
        session: String,
    ) -> Result<(), StoreError> {
        let owner = serde_json::to_string(&owner)?;
        let mut after = String::new();
        loop {
            let next = self
                .data
                .query(NextRun(owner.clone(), session.clone(), after))
                .await?;
            let Some(run) = next else { break };
            self.data
                .write(Release {
                    owner: owner.clone(),
                    session: session.clone(),
                    run: Some(run.clone()),
                })
                .await?;
            after = run;
        }
        self.data
            .write(Release {
                owner,
                session,
                run: None,
            })
            .await
    }
}

struct NextRun(String, String, String);
impl Query for NextRun {
    type Output = Option<String>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        Ok(c.prepare_cached(
            "SELECT run FROM agent_run_specs WHERE owner=?1 AND session=?2 AND run>?3 ORDER BY run LIMIT 1",
        )?
        .query_row(params![self.0, self.1, self.2], |row| row.get(0))
        .optional()?)
    }
}

fn execute_steps(
    c: &Connection,
    steps: &[Step],
    run: Option<&str>,
    owner: &str,
    session: &str,
) -> Result<usize, StoreError> {
    let mut changed = 0;
    for &step in steps {
        changed += match step {
            Step::Run(sql) => {
                let run = run.expect("run step requires run id");
                c.prepare_cached(sql)?.execute([run])?
            }
            Step::RunOwnerSession(sql) => {
                let run = run.expect("run step requires run id");
                c.prepare_cached(sql)?
                    .execute(params![run, owner, session])?
            }
            Step::Session(sql) => c.prepare_cached(sql)?.execute([session])?,
            Step::OwnerSession(sql) => c.prepare_cached(sql)?.execute(params![owner, session])?,
        };
    }
    Ok(changed)
}

struct Release {
    owner: String,
    session: String,
    run: Option<String>,
}
impl Statement for Release {
    type Value = ();
    type Output = ();
    fn execute(self, c: &Connection) -> Result<Prepared<()>, StoreError> {
        let fenced: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM session_retirements WHERE session_id=? AND remove_session=1)",
            [&self.session],
            |row| row.get(0),
        )?;
        if !fenced {
            return Err(invalid("only a removed Session releases its history"));
        }
        let changed = match self.run.as_deref() {
            Some(run) => {
                let preserve_profile_computer: bool = c
                    .prepare_cached(
                        "SELECT EXISTS(SELECT 1 FROM agent_computer_grants WHERE run=?1 AND scope='profile')
                         OR EXISTS(
                           SELECT 1 FROM agent_computer_facts
                           WHERE run=?1 AND json_extract(fact_json,'$.kind')='profile_grant_revoked'
                         )",
                    )?
                    .query_row([run], |row| row.get(0))?;
                let tail = if preserve_profile_computer {
                    RUN_PROFILE_COMPUTER_TAIL
                } else {
                    RUN_FULL_TAIL
                };
                execute_steps(
                    c,
                    RUN_HISTORY_RELEASES,
                    Some(run),
                    &self.owner,
                    &self.session,
                )? + execute_steps(c, tail, Some(run), &self.owner, &self.session)?
            }
            None => execute_steps(c, SESSION_RELEASES, None, &self.owner, &self.session)?,
        };
        Ok(Prepared {
            value: (),
            changed: changed != 0,
            notification: if changed != 0 {
                Notification::MATERIAL_RELEASED
                    .combine(Notification::METADATA.with_sessions([self.session]))
            } else {
                Notification::NONE
            },
        })
    }
    fn committed(_: ()) {}
    fn isolated_rejection(_: &StoreError) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::super::stop_tests::{enqueue, open, spec};
    use super::*;
    use crate::computer::{Change as ComputerChange, Fact as ComputerFact, Subject};
    use maka_agent_facts::{
        durable::{AuthorizationObligation, ExecutionIdentity, FactId, ModelAttemptId, ToolKey},
        interaction::{
            ComputerAppActivity, ComputerAppDecision, ComputerAppDisplay, ComputerAppPlatform,
            GrantCapability, GrantScope, GrantTarget, InteractionOutcome, InteractionQuestion,
            InteractionRecord, InteractionRequest, QuestionOption,
        },
        model::{ModelToolCall, ToolInput},
        tool_call::tool_use_id,
    };
    use maka_plugin_core::{
        composition::InstanceId,
        contract::Transport,
        deployment::DeploymentRef,
        operation::{RecoveryContract, RecoveryProtocol, RecoveryRef},
    };
    use std::collections::BTreeSet;
    use uuid::Uuid;

    struct Sql(&'static str, String);
    impl Query for Sql {
        type Output = Vec<i64>;
        fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
            Ok(c.prepare(self.0)?
                .query_map([self.1], |row| row.get(0))?
                .collect::<Result<_, _>>()?)
        }
    }
    struct SeedSession(String, maka_sandbox::workspace::PermissionBasis);
    impl Statement for SeedSession {
        type Value = ();
        type Output = ();
        fn execute(self, c: &Connection) -> Result<Prepared<()>, StoreError> {
            let binding = self.1.binding;
            c.execute(
                "INSERT OR IGNORE INTO workspace_bindings(id,owner_scope,selection_digest,workspace_json,permission_epoch,metadata_epoch) VALUES(?,'scope','digest','{}',?,0)",
                params![binding.id.to_string(), binding.permission_epoch as i64],
            )?;
            let config = serde_json::json!({
                "workspace": maka_sandbox::workspace::BindingRef {
                    id: binding.id,
                    permission_epoch_at_attach: binding.permission_epoch,
                    metadata_epoch_at_attach: 0,
                },
                "boundary_revision": self.1.boundary_revision,
                "permissions": { "access": "workspace_write" },
            });
            c.execute(
                "INSERT INTO session_control(id,fingerprint,revision,created_at,updated_at,archived,configuration) VALUES(?,'fp',1,1,1,0,?)",
                params![self.0, config.to_string()],
            )?;
            Ok(Prepared {
                value: (),
                changed: true,
                notification: Notification::NONE,
            })
        }
        fn committed(_: ()) {}
        fn isolated_rejection(_: &StoreError) -> bool {
            false
        }
    }
    struct SeedTool(RunId, crate::fold::Tool);
    impl Statement for SeedTool {
        type Value = ();
        type Output = ();
        fn execute(self, c: &Connection) -> Result<Prepared<()>, StoreError> {
            c.execute(
                "INSERT INTO agent_tools(run,key,pending,body) VALUES(?,?,1,?)",
                params![
                    self.0.to_string(),
                    crate::fold::tool_key(&self.1.key),
                    serde_json::to_string(&self.1)?,
                ],
            )?;
            Ok(Prepared {
                value: (),
                changed: true,
                notification: Notification::NONE,
            })
        }
        fn committed(_: ()) {}
        fn isolated_rejection(_: &StoreError) -> bool {
            false
        }
    }
    struct Fence(String);
    impl Statement for Fence {
        type Value = ();
        type Output = ();
        fn execute(self, c: &Connection) -> Result<Prepared<()>, StoreError> {
            c.execute(
                "INSERT INTO session_retirements(session_id,remove_session,completed) VALUES(?,1,1)",
                [self.0],
            )?;
            Ok(Prepared {
                value: (),
                changed: true,
                notification: Notification::NONE,
            })
        }
        fn committed(_: ()) {}
        fn isolated_rejection(_: &StoreError) -> bool {
            false
        }
    }
    async fn rows(store: &Store, sql: &'static str, arg: &str) -> Vec<i64> {
        store.data.query(Sql(sql, arg.into())).await.unwrap()
    }

    #[tokio::test]
    async fn removed_session_releases_its_history_and_keeps_shared_content() {
        let directory = tempfile::tempdir().unwrap();
        let (root, store) = open(directory.path(), true).await;
        let (mut removed, contents) = spec();
        removed.session_id = "removed".into();
        let mut kept = removed.clone();
        kept.session_id = "kept".into();
        let first = Admission::new(removed.clone(), UnixMillis(1), contents.clone());
        store.admit(first.clone()).await.unwrap();
        let mut second_spec = removed.clone();
        second_spec.turn_id = "second-turn".into();
        second_spec.trigger = Trigger::Message {
            message_id: "second-message".into(),
        };
        let second = Admission::new(second_spec, UnixMillis(2), contents.clone());
        store.admit(second.clone()).await.unwrap();
        enqueue(&store, &removed, "queued", None).await;
        let survivor = Admission::new(kept.clone(), UnixMillis(3), contents);
        store.admit(survivor.clone()).await.unwrap();

        let referenced =
            "SELECT DISTINCT content_id FROM content_references WHERE ?1=?1 ORDER BY 1";
        let before = rows(&store, referenced, "").await;
        let owned = "SELECT count(*) FROM agent_run_specs WHERE session=?1";
        assert_eq!(rows(&store, owned, "removed").await, vec![2]);

        // A live Session is never released.
        assert!(
            store
                .release_removed_session(removed.owner.clone(), "removed".into())
                .await
                .is_err()
        );
        store.data.write(Fence("removed".into())).await.unwrap();
        for _ in 0..2 {
            store
                .release_removed_session(removed.owner.clone(), "removed".into())
                .await
                .unwrap();
        }

        let after = rows(&store, referenced, "").await;
        let released: Vec<_> = before.iter().filter(|id| !after.contains(id)).collect();
        assert!(!released.is_empty());
        let pending = rows(
            &store,
            "SELECT content_id FROM pending_content_releases WHERE ?1=?1",
            "",
        )
        .await;
        let stored = rows(&store, "SELECT id FROM contents WHERE ?1=?1", "").await;
        assert!(
            released
                .iter()
                .all(|id| pending.contains(id) || !stored.contains(id))
        );
        for table in [
            owned,
            "SELECT count(*) FROM agent_session_history WHERE session=?1",
            "SELECT count(*) FROM agent_recall_messages WHERE session=?1",
            "SELECT count(*) FROM agent_queue_events WHERE session=?1",
        ] {
            assert_eq!(rows(&store, table, "removed").await, vec![0], "{table}");
        }
        for run in [first.run(), second.run()] {
            assert_eq!(
                rows(
                    &store,
                    "SELECT count(*) FROM agent_history_content_refs WHERE run=?1",
                    &run.to_string(),
                )
                .await,
                vec![0]
            );
        }
        assert_eq!(
            rows(
                &store,
                "SELECT count(*) FROM pragma_foreign_key_check WHERE ?1=?1",
                "",
            )
            .await,
            vec![0]
        );
        assert_eq!(rows(&store, owned, "kept").await, vec![1]);
        store.frontier(survivor.run()).await.unwrap();
        drop(store);
        root.close().await.unwrap();
    }

    #[tokio::test]
    async fn removed_session_releases_cells_and_catalog_projections_while_preserving_standalone_and_events()
     {
        let directory = tempfile::tempdir().unwrap();
        let (root, store) = open(directory.path(), true).await;
        let (mut removed, contents) = spec();
        removed.session_id = "removed".into();
        let mut kept = removed.clone();
        kept.session_id = "kept".into();
        let removed_run = Admission::new(removed.clone(), UnixMillis(1), contents.clone());
        store.admit(removed_run.clone()).await.unwrap();
        let kept_run = Admission::new(kept.clone(), UnixMillis(2), contents);
        store.admit(kept_run.clone()).await.unwrap();

        struct SeedCellsAndCatalog {
            owner: String,
            removed_run: String,
            kept_run: String,
        }
        impl Statement for SeedCellsAndCatalog {
            type Value = ();
            type Output = ();
            fn execute(self, c: &Connection) -> Result<Prepared<()>, StoreError> {
                c.execute(
                    "INSERT INTO agent_cells(cell,session,run,pending,body) VALUES('cell-run','removed',?,0,'{}')",
                    [&self.removed_run],
                )?;
                c.execute(
                    "INSERT INTO agent_cells(cell,session,run,pending,body) VALUES('cell-standalone','removed',NULL,0,'{}')",
                    [],
                )?;
                c.execute(
                    "INSERT INTO agent_cells(cell,session,run,pending,body) VALUES('cell-kept','kept',?,0,'{}')",
                    [&self.kept_run],
                )?;
                for session in ["removed", "kept"] {
                    c.execute(
                        "INSERT INTO agent_catalog_controls(owner,session,revision,read_through) VALUES(?,?,1,1)",
                        params![self.owner, session],
                    )?;
                    c.execute(
                        "INSERT INTO agent_catalog_events(owner,session,revision,id,at,schema_version,command_json,event_json) VALUES(?,?,1,'cmd-1',1,1,'{}','{}')",
                        params![self.owner, session],
                    )?;
                }
                Ok(Prepared {
                    value: (),
                    changed: true,
                    notification: Notification::NONE,
                })
            }
            fn committed(_: ()) {}
            fn isolated_rejection(_: &StoreError) -> bool {
                false
            }
        }

        store
            .data
            .write(SeedCellsAndCatalog {
                owner: serde_json::to_string(&removed.owner).unwrap(),
                removed_run: removed_run.run().to_string(),
                kept_run: kept_run.run().to_string(),
            })
            .await
            .unwrap();
        assert_eq!(
            rows(
                &store,
                "SELECT count(*) FROM agent_catalog_sessions WHERE session=?1",
                "removed"
            )
            .await,
            vec![1]
        );

        store.data.write(Fence("removed".into())).await.unwrap();
        store
            .release_removed_session(removed.owner.clone(), "removed".into())
            .await
            .unwrap();

        assert_eq!(
            rows(
                &store,
                "SELECT count(*) FROM agent_cells WHERE run=?1",
                &removed_run.run().to_string()
            )
            .await,
            vec![0]
        );
        assert_eq!(
            rows(
                &store,
                "SELECT count(*) FROM agent_cells WHERE cell=?1",
                "cell-standalone"
            )
            .await,
            vec![1]
        );
        assert_eq!(
            rows(
                &store,
                "SELECT count(*) FROM agent_cells WHERE cell=?1",
                "cell-kept"
            )
            .await,
            vec![1]
        );
        assert_eq!(
            rows(
                &store,
                "SELECT count(*) FROM agent_catalog_sessions WHERE session=?1",
                "removed"
            )
            .await,
            vec![0]
        );
        assert_eq!(
            rows(
                &store,
                "SELECT count(*) FROM agent_catalog_controls WHERE session=?1",
                "removed"
            )
            .await,
            vec![0]
        );
        assert_eq!(
            rows(
                &store,
                "SELECT count(*) FROM agent_catalog_events WHERE session=?1",
                "removed"
            )
            .await,
            vec![1]
        );
        assert_eq!(
            rows(
                &store,
                "SELECT count(*) FROM agent_catalog_sessions WHERE session=?1",
                "kept"
            )
            .await,
            vec![1]
        );
        assert_eq!(
            rows(
                &store,
                "SELECT count(*) FROM agent_catalog_controls WHERE session=?1",
                "kept"
            )
            .await,
            vec![1]
        );
        assert_eq!(
            rows(
                &store,
                "SELECT count(*) FROM pragma_foreign_key_check WHERE ?1=?1",
                ""
            )
            .await,
            vec![0]
        );

        drop(store);
        root.close().await.unwrap();
    }

    #[tokio::test]
    async fn releases_ordinary_interactions_and_preserves_profile_grants_across_rebuilds() {
        let directory = tempfile::tempdir().unwrap();
        let (root, store) = open(directory.path(), true).await;

        // 1. Removed session with an ordinary Question interaction is completely reclaimed.
        let (mut ordinary_spec, ordinary_contents) = spec();
        ordinary_spec.session_id = "ordinary-removed".into();
        let ordinary = Admission::new(ordinary_spec.clone(), UnixMillis(10), ordinary_contents);
        store.admit(ordinary.clone()).await.unwrap();
        let ordinary_view = store.frontier(ordinary.run()).await.unwrap();
        let ordinary_claim = store.claim(ordinary.run()).await.unwrap();
        store
            .interactions()
            .establish(
                &ordinary_claim,
                Head::from(&ordinary_view),
                InteractionRecord {
                    request_id: "req-ordinary".into(),
                    execution: ExecutionIdentity {
                        session_id: ordinary_spec.session_id.clone(),
                        turn_id: ordinary_spec.turn_id.clone(),
                        run_id: ordinary.run(),
                    },
                    created_at: 11,
                    request: InteractionRequest::Question {
                        tool_use_id: tool_use_id(ordinary.run(), "question-1"),
                        questions: vec![InteractionQuestion {
                            question: "Proceed?".into(),
                            options: vec![
                                QuestionOption {
                                    label: "Yes".into(),
                                    description: None,
                                },
                                QuestionOption {
                                    label: "No".into(),
                                    description: None,
                                },
                            ],
                        }],
                    },
                    outcome: None,
                },
                None,
                vec![],
            )
            .await
            .unwrap();
        drop(ordinary_claim);
        store
            .data
            .write(Fence(ordinary_spec.session_id.clone()))
            .await
            .unwrap();
        store
            .release_removed_session(
                ordinary_spec.owner.clone(),
                ordinary_spec.session_id.clone(),
            )
            .await
            .unwrap();
        assert_eq!(
            rows(
                &store,
                "SELECT count(*) FROM agent_run_specs WHERE session=?1",
                "ordinary-removed",
            )
            .await,
            vec![0]
        );
        assert_eq!(
            rows(
                &store,
                "SELECT count(*) FROM agent_interaction_heads WHERE session=?1",
                "ordinary-removed",
            )
            .await,
            vec![0]
        );

        // 2. Removed session with a profile-scoped computer grant: releases agent_facts
        //    but retains canonical backing so computer::rebuild & interactions::rebuild
        //    keep the grant and never resurrect a pending request.
        let (mut profile_spec, profile_contents) = spec();
        profile_spec.session_id = "profile-removed".into();
        store
            .data
            .write(SeedSession(
                profile_spec.session_id.clone(),
                profile_spec.permission_basis,
            ))
            .await
            .unwrap();
        let profile = Admission::new(profile_spec.clone(), UnixMillis(20), profile_contents);
        store.admit(profile.clone()).await.unwrap();
        let profile_view = store.frontier(profile.run()).await.unwrap();
        let profile_claim = store.claim(profile.run()).await.unwrap();
        let profile_execution = ExecutionIdentity {
            session_id: profile_spec.session_id.clone(),
            turn_id: profile_spec.turn_id.clone(),
            run_id: profile.run(),
        };
        let capture_blob =
            ContentBlob::json(&serde_json::json!({"kind": "computer-capture"})).unwrap();
        let target = GrantTarget {
            provider_id: "computer".into(),
            contract_id: "computer_app".into(),
            server_id: "local".into(),
            tool_name: "cua".into(),
            capability: GrantCapability::ComputerUse,
            scope: GrantScope::ComputerApp {
                platform: ComputerAppPlatform::Macos,
                application_id: "com.example.demo".into(),
            },
        };
        let display = ComputerAppDisplay {
            name: "Demo App".into(),
            app_path: "/Applications/Demo.app".into(),
            risk: None,
            warning: None,
        };
        let basis = profile_spec.permission_basis;
        let tool_key = ToolKey {
            attempt: ModelAttemptId::new(),
            call: "call-1".into(),
        };
        let obligation = AuthorizationObligation::Tool {
            tool: tool_key.clone(),
        };
        let recovery_ref = RecoveryRef {
            source: DeploymentRef {
                state_domain: "a".repeat(64),
                deployment: profile_spec.owner.deployment,
                revision: 1,
            },
            namespace: InstanceId(vec![Uuid::new_v4()]),
            export: "computer".into(),
            method: "exec".into(),
            operation: Uuid::new_v4(),
            fingerprint: format!("sha256-{}", "0".repeat(64)),
            contract: RecoveryContract {
                name: "computer.exec".into(),
                version: 1,
                transport: Transport::Local,
                digest: format!("sha256-{}", "0".repeat(64)),
            },
            recovery: RecoveryProtocol::JournalV1,
        };
        store
            .data
            .write(SeedTool(
                profile.run(),
                crate::fold::Tool {
                    key: tool_key.clone(),
                    call: ModelToolCall {
                        id: "call-1".into(),
                        name: "cua".into(),
                        input: ToolInput::Json(serde_json::json!({})),
                        provider_options: None,
                        provider_executed: false,
                    },
                    decision: None,
                    approval_refusal: None,
                    original: Some(recovery_ref.clone()),
                    receipt: None,
                    provider_result: None,
                    local_returned: None,
                    host_returned: None,
                    prohibited_before_host: None,
                    admitted: true,
                    accepted: None,
                },
            ))
            .await
            .unwrap();
        let native_op = "native-op-1".to_owned();
        let subject = Subject {
            activity: ComputerAppActivity {
                execution: profile_execution.clone(),
                operation_id: native_op.clone(),
                target: target.clone(),
                display: display.clone(),
            },
            basis,
            allow_always: true,
            target: obligation,
            operation: recovery_ref,
            capture: capture_blob.reference().clone(),
        };
        store
            .computer()
            .append(
                &profile_claim,
                Head::from(&profile_view),
                ComputerChange {
                    id: FactId::new(),
                    at: UnixMillis(21),
                    fact: ComputerFact::SubjectObserved { subject },
                },
                vec![capture_blob],
            )
            .await
            .unwrap();
        let t_id = tool_use_id(profile.run(), &crate::fold::tool_key(&tool_key));
        store
            .interactions()
            .establish(
                &profile_claim,
                Head::from(&profile_view),
                InteractionRecord {
                    request_id: "req-profile".into(),
                    execution: profile_execution,
                    created_at: 22,
                    request: InteractionRequest::ComputerApp {
                        tool_use_id: t_id,
                        native_operation_id: native_op,
                        target,
                        basis,
                        display,
                        allow_always: true,
                        authority_revision: 0,
                    },
                    outcome: None,
                },
                None,
                vec![],
            )
            .await
            .unwrap();
        drop(profile_claim);
        store
            .interactions()
            .commit_outcome(
                &profile_spec.session_id,
                "req-profile",
                InteractionOutcome::ComputerAppDecision {
                    decision: ComputerAppDecision::Always,
                    committed_at: 23,
                },
            )
            .await
            .unwrap();

        store
            .data
            .write(Fence(profile_spec.session_id.clone()))
            .await
            .unwrap();
        store
            .release_removed_session(profile_spec.owner.clone(), profile_spec.session_id.clone())
            .await
            .unwrap();

        assert_eq!(
            rows(
                &store,
                "SELECT count(*) FROM agent_facts WHERE run=?1",
                &profile.run().to_string(),
            )
            .await,
            vec![0]
        );
        assert_eq!(
            rows(
                &store,
                "SELECT count(*) FROM pragma_foreign_key_check WHERE ?1=?1",
                "",
            )
            .await,
            vec![0]
        );

        // Rebuilding both projections preserves the profile grant and does not resurrect pending.
        store.computer().rebuild().await.unwrap();
        assert_eq!(
            rows(
                &store,
                "SELECT count(*) FROM agent_computer_grants WHERE session=?1 AND scope='profile'",
                "profile-removed",
            )
            .await,
            vec![1]
        );
        store
            .interactions()
            .rebuild(&profile_spec.session_id)
            .await
            .unwrap();
        assert_eq!(
            rows(
                &store,
                "SELECT count(*) FROM agent_interaction_pending WHERE session=?1",
                "profile-removed",
            )
            .await,
            vec![0]
        );

        drop(store);
        root.close().await.unwrap();
    }

    #[tokio::test]
    async fn removal_queries_have_no_table_scans_and_account_for_all_agent_tables() {
        let directory = tempfile::tempdir().unwrap();
        let (root, store) = open(directory.path(), true).await;

        struct Audit;
        impl Query for Audit {
            type Output = (Vec<(String, String)>, Vec<String>);
            fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
                let mut scans = Vec::new();
                for sql in [
                    "DELETE FROM agent_facts WHERE run=?1",
                    "DELETE FROM agent_run_specs WHERE run=?1",
                    "DELETE FROM agent_request_specs WHERE run=?1",
                    "DELETE FROM agent_interaction_requests WHERE run=?1",
                    "DELETE FROM agent_computer_facts WHERE run=?1",
                    "DELETE FROM agent_queue_events WHERE session=?1",
                    "DELETE FROM agent_cell_notifications WHERE session=?1",
                    "DELETE FROM agent_history_content_refs WHERE run=?1",
                    "DELETE FROM agent_cells WHERE run=?1",
                    "DELETE FROM agent_catalog_sessions WHERE owner=?1 AND session=?2",
                    "DELETE FROM agent_catalog_controls WHERE owner=?1 AND session=?2",
                    "DELETE FROM agent_continuation_successors WHERE run=?1 OR source_run=?1",
                ] {
                    let mut stmt = c.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
                    let n = stmt.parameter_count();
                    let plan: Vec<String> = stmt
                        .query_map(
                            rusqlite::params_from_iter(std::iter::repeat_n("probe", n)),
                            |row| row.get(3),
                        )?
                        .collect::<Result<_, _>>()?;
                    for detail in plan {
                        if detail.starts_with("SCAN ") {
                            scans.push((sql.into(), detail));
                        }
                    }
                }
                let tables: Vec<String> = c
                    .prepare(
                        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'agent_%' ORDER BY name",
                    )?
                    .query_map([], |row| row.get(0))?
                    .collect::<Result<_, _>>()?;
                Ok((scans, tables))
            }
        }

        let (scans, tables) = store.data.query(Audit).await.unwrap();
        assert!(
            scans.is_empty(),
            "unexpected table scans during removal: {scans:?}"
        );

        let handled_in_sql: BTreeSet<&str> = [
            "agent_answer_parts",
            "agent_approvals",
            "agent_artifact_run_bindings",
            "agent_attempt_ids",
            "agent_attempts",
            "agent_blockers",
            "agent_catalog_controls",
            "agent_catalog_messages",
            "agent_catalog_runs",
            "agent_catalog_sessions",
            "agent_cell_notifications",
            "agent_cells",
            "agent_computer_activities",
            "agent_computer_authorizations",
            "agent_computer_facts",
            "agent_computer_grants",
            "agent_computer_native_bindings",
            "agent_computer_native_turn_fences",
            "agent_computer_stops",
            "agent_computer_subjects",
            "agent_content_pins",
            "agent_continuation_successors",
            "agent_diagnostic_coverage",
            "agent_diagnostics",
            "agent_external_effects",
            "agent_external_publication_items",
            "agent_external_publications",
            "agent_external_steering",
            "agent_facts",
            "agent_history_content_refs",
            "agent_history_queue_requests",
            "agent_history_snapshot_adoptions",
            "agent_history_tool_metadata",
            "agent_interaction_capabilities",
            "agent_interaction_grants",
            "agent_interaction_heads",
            "agent_interaction_outcomes",
            "agent_interaction_pending",
            "agent_interaction_requests",
            // Deleting history, recall messages and their derived rows cascades to these indexes.
            "agent_memory_cell_candidates",
            "agent_memory_cell_events",
            "agent_memory_cell_observations",
            "agent_memory_recall_attachments",
            "agent_memory_recall_calls",
            "agent_memory_run_restrictions",
            "agent_memory_shared_fields",
            "agent_message_submissions",
            "agent_memory_tool_inputs",
            "agent_memory_history_reads",
            "agent_memory_external_epochs",
            "agent_memory_legacy_sources",
            "agent_memory_legacy_recap_history",
            "agent_model_items",
            "agent_operation_pins",
            "agent_queue_content_pins",
            "agent_queue_events",
            "agent_queue_heads",
            "agent_queue_items",
            "agent_recall_gaps",
            "agent_recall_heads",
            "agent_recall_messages",
            "agent_recall_terms",
            "agent_request_specs",
            "agent_run_specs",
            "agent_runs",
            "agent_session_history",
            "agent_session_loaded_tools",
            "agent_session_values",
            "agent_steps",
            "agent_tools",
            "agent_waits",
        ]
        .into_iter()
        .collect();
        let retained_or_global: BTreeSet<&str> = [
            "agent_artifacts",
            "agent_catalog_events",
            "agent_catalog_revision",
            "agent_computer_revocations",
            "agent_executor_profile_contents",
            "agent_history_snapshot_catalog",
            "agent_history_snapshot_entries",
            "agent_history_snapshot_imports",
            "agent_history_snapshot_ingest_edges",
            "agent_history_snapshot_ingest_frames",
            "agent_history_snapshot_ingest_nodes",
            "agent_history_snapshot_inventory_pages",
            "agent_history_snapshot_nav_chunks",
            "agent_history_snapshot_nav_documents",
            "agent_history_snapshot_nav_fields",
            "agent_history_snapshot_nav_heads",
            "agent_history_snapshot_nav_terms",
            "agent_history_snapshot_pins",
            "agent_history_snapshot_positions",
            "agent_history_snapshot_run_refs",
            "agent_history_snapshots",
            "agent_memory_indexed_snapshots",
            "agent_memory_snapshot_outputs",
            "agent_memories",
            "agent_memory_evidence",
            "agent_memory_history_boundary",
            // Imported bindings follow their snapshot; frozen aliases follow the retained run spec.
            "agent_memory_imported_tools",
            "agent_memory_read_aliases",
            // The scoped fact index belongs to the memory record and survives session removal.
            "agent_memory_recall_keys",
            "agent_memory_recall_terms",
            "agent_memory_matches",
            "agent_memory_relations",
            "agent_memory_scopes",
            "agent_memory_search",
            "agent_memory_versions",
            "agent_memory_visibility",
            "agent_room_members",
            "agent_room_messages",
            "agent_room_pins",
            "agent_room_reactions",
            "agent_room_search",
            "agent_room_search_docs",
            "agent_rooms",
            "agent_session_artifact_registrations",
            "agent_standalone_cell_events",
            "agent_standalone_cell_pins",
            "agent_subagent_presets",
            "agent_usage_aux_events",
            "agent_usage_aux_specs",
            "agent_usage_calls",
            "agent_usage_results",
        ]
        .into_iter()
        .collect();
        let unaccounted: Vec<String> = tables
            .into_iter()
            .filter(|t| {
                !t.ends_with("_config")
                    && !t.ends_with("_content")
                    && !t.ends_with("_data")
                    && !t.ends_with("_docsize")
                    && !t.ends_with("_idx")
            })
            .filter(|t| {
                !handled_in_sql.contains(t.as_str()) && !retained_or_global.contains(t.as_str())
            })
            .collect();
        assert!(
            unaccounted.is_empty(),
            "new agent_* tables must be added to removal.rs or classified here: {unaccounted:?}"
        );

        drop(store);
        root.close().await.unwrap();
    }
}

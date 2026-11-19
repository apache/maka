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

// ?1 run, ?2 owner, ?3 session. Children before parents so foreign keys hold.
const RUN_RELEASES: &[&str] = &[
    "INSERT OR IGNORE INTO pending_content_releases(content_id)
     SELECT body_content_id FROM agent_facts WHERE run=?1
     UNION SELECT content_id FROM agent_content_pins WHERE run=?1
     UNION SELECT content_id FROM agent_request_specs WHERE run=?1
     UNION SELECT content_id FROM agent_answer_parts WHERE run=?1
     UNION SELECT descriptor_content_id FROM agent_external_steering WHERE run=?1
     UNION SELECT content_id FROM agent_history_content_refs WHERE owner=?2 AND session=?3 AND run=?1
     UNION SELECT spec_content_id FROM agent_run_specs WHERE run=?1",
    "DELETE FROM agent_recall_terms WHERE rowid IN(SELECT id FROM agent_recall_messages
     WHERE owner=?2 AND session=?3 AND sequence IN(SELECT sequence FROM agent_facts WHERE run=?1))",
    "DELETE FROM agent_recall_messages WHERE owner=?2 AND session=?3
     AND sequence IN(SELECT sequence FROM agent_facts WHERE run=?1)",
    "DELETE FROM agent_session_history WHERE sequence IN(SELECT sequence FROM agent_facts WHERE run=?1)",
    "DELETE FROM agent_history_content_refs WHERE owner=?2 AND session=?3 AND run=?1",
    "DELETE FROM agent_catalog_messages WHERE owner=?2 AND session=?3
     AND sequence IN(SELECT sequence FROM agent_facts WHERE run=?1)",
    "DELETE FROM agent_catalog_runs WHERE run=?1",
    "DELETE FROM agent_diagnostic_coverage WHERE run=?1",
    "DELETE FROM agent_diagnostics WHERE run=?1",
    "DELETE FROM agent_external_publication_items WHERE run=?1",
    "DELETE FROM agent_external_publications WHERE run=?1",
    "DELETE FROM agent_external_effects WHERE run=?1",
    "DELETE FROM agent_external_steering WHERE run=?1",
    "DELETE FROM agent_continuation_successors WHERE run=?1 OR source_run=?1",
    "DELETE FROM agent_history_snapshot_adoptions WHERE run=?1",
    "DELETE FROM agent_artifact_run_bindings WHERE run=?1",
    "DELETE FROM agent_model_items WHERE run=?1",
    "DELETE FROM agent_computer_native_turn_fences WHERE run=?1",
    "DELETE FROM agent_computer_native_bindings WHERE run=?1",
    "DELETE FROM agent_computer_facts WHERE run=?1",
    // Profile-scoped computer grants outlive the Session that asked for them.
    "DELETE FROM agent_computer_grants WHERE scope<>'profile'
     AND request IN(SELECT request FROM agent_interaction_requests WHERE run=?1)",
    "DELETE FROM agent_interaction_grants WHERE request IN(SELECT request FROM agent_interaction_requests WHERE run=?1)",
    "DELETE FROM agent_interaction_outcomes WHERE request IN(SELECT request FROM agent_interaction_requests WHERE run=?1)",
    "DELETE FROM agent_interaction_pending WHERE request IN(SELECT request FROM agent_interaction_requests WHERE run=?1)",
    "DELETE FROM agent_interaction_requests WHERE run=?1
     AND NOT EXISTS(SELECT 1 FROM agent_computer_grants g WHERE g.request=agent_interaction_requests.request)",
    "DELETE FROM agent_attempt_ids WHERE run=?1",
    "DELETE FROM agent_request_specs WHERE run=?1",
    "DELETE FROM agent_attempts WHERE run=?1",
    "DELETE FROM agent_steps WHERE run=?1",
    "DELETE FROM agent_tools WHERE run=?1",
    "DELETE FROM agent_approvals WHERE run=?1",
    "DELETE FROM agent_blockers WHERE run=?1",
    "DELETE FROM agent_waits WHERE run=?1",
    "DELETE FROM agent_operation_pins WHERE run=?1",
    "DELETE FROM agent_answer_parts WHERE run=?1",
    "DELETE FROM agent_content_pins WHERE run=?1",
    "DELETE FROM agent_facts WHERE run=?1",
    "DELETE FROM agent_runs WHERE run=?1",
    "DELETE FROM agent_run_specs WHERE run=?1
     AND NOT EXISTS(SELECT 1 FROM agent_interaction_requests WHERE run=?1)",
];

// ?1 owner, ?2 session.
const SESSION_RELEASES: &[&str] = &[
    "INSERT OR IGNORE INTO pending_content_releases(content_id)
     SELECT body_content_id FROM agent_queue_events WHERE session=?2
     UNION SELECT content_id FROM agent_queue_content_pins WHERE session=?2
     UNION SELECT content_id FROM agent_cell_notifications WHERE session=?2
     UNION SELECT value_content_id FROM agent_session_values WHERE session=?2",
    "DELETE FROM agent_history_queue_requests WHERE session=?2",
    "DELETE FROM agent_queue_events WHERE session=?2",
    "DELETE FROM agent_queue_content_pins WHERE session=?2",
    "DELETE FROM agent_queue_items WHERE session=?2",
    "DELETE FROM agent_queue_heads WHERE session=?2",
    "DELETE FROM agent_cell_notifications WHERE session=?2",
    "DELETE FROM agent_session_values WHERE session=?2",
    "DELETE FROM agent_session_loaded_tools WHERE session=?2",
    "DELETE FROM agent_interaction_capabilities WHERE session=?2",
    "DELETE FROM agent_recall_heads WHERE owner=?1 AND session=?2",
    "DELETE FROM agent_recall_gaps WHERE owner=?1 AND session=?2",
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

    /// Removed Sessions that finished retirement before their history was released.
    pub async fn removed_sessions_with_history(
        &self,
        owner: RunOwner,
        after: Option<String>,
    ) -> Result<Vec<String>, StoreError> {
        self.data
            .query(RemovedWithHistory(serde_json::to_string(&owner)?, after))
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

struct RemovedWithHistory(String, Option<String>);
impl Query for RemovedWithHistory {
    type Output = Vec<String>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        Ok(c.prepare_cached(
            "SELECT t.session_id FROM session_retirements t
             WHERE t.remove_session=1 AND t.completed=1 AND (?2 IS NULL OR t.session_id>?2)
             AND EXISTS(SELECT 1 FROM agent_run_specs r
               WHERE r.owner=?1 AND r.session=t.session_id
               AND NOT EXISTS(SELECT 1 FROM agent_interaction_requests i WHERE i.run=r.run))
             ORDER BY t.session_id LIMIT 32",
        )?
        .query_map(params![self.0, self.1], |row| row.get(0))?
        .collect::<Result<_, _>>()?)
    }
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
        let (statements, values) = match &self.run {
            Some(run) => (RUN_RELEASES, vec![run, &self.owner, &self.session]),
            None => (SESSION_RELEASES, vec![&self.owner, &self.session]),
        };
        let mut changed = 0;
        for sql in statements {
            let mut statement = c.prepare_cached(sql)?;
            let used = statement.parameter_count();
            changed += statement.execute(rusqlite::params_from_iter(&values[..used]))?;
        }
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

    struct Sql(&'static str, String);
    impl Query for Sql {
        type Output = Vec<i64>;
        fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
            Ok(c.prepare(self.0)?
                .query_map([self.1], |row| row.get(0))?
                .collect::<Result<_, _>>()?)
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
        assert_eq!(
            store
                .removed_sessions_with_history(removed.owner.clone(), None)
                .await
                .unwrap(),
            vec!["removed".to_owned()]
        );
        for _ in 0..2 {
            store
                .release_removed_session(removed.owner.clone(), "removed".into())
                .await
                .unwrap();
        }

        let after = rows(&store, referenced, "").await;
        let released: Vec<_> = before.iter().filter(|id| !after.contains(id)).collect();
        assert!(!released.is_empty());
        // The Root collector may already have deleted them; otherwise they wait in its queue.
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
        assert_eq!(rows(&store, owned, "removed").await, vec![0]);
        for table in [
            "SELECT count(*) FROM agent_session_history WHERE session=?1",
            "SELECT count(*) FROM agent_history_content_refs WHERE session=?1",
            "SELECT count(*) FROM agent_recall_messages WHERE session=?1",
            "SELECT count(*) FROM agent_queue_events WHERE session=?1",
        ] {
            assert_eq!(rows(&store, table, "removed").await, vec![0], "{table}");
        }
        assert!(
            store
                .removed_sessions_with_history(removed.owner.clone(), None)
                .await
                .unwrap()
                .is_empty()
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
        // The surviving Session still reads the content it shared with the removed one.
        assert_eq!(rows(&store, owned, "kept").await, vec![1]);
        store.frontier(survivor.run()).await.unwrap();
        drop(store);
        root.close().await.unwrap();
    }
}

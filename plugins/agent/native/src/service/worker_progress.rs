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
use crate::owner::worker_progress::Rows;
use tokio::time::{Duration, Instant};
fn waiting(kind: WorkerProgressKind) -> bool {
    matches!(
        kind,
        WorkerProgressKind::Approval
            | WorkerProgressKind::Permission
            | WorkerProgressKind::Form
            | WorkerProgressKind::Question
    )
}
pub(super) async fn watch(
    owner: Arc<Owner>,
    input: WorkerProgressRead,
    context: Context,
) -> Result<Value, String> {
    history::authorize(&owner, context.scope(), &input.parent_session_id).await?;
    if context.scope().identity.agent().is_some() {
        let access = owner.access_for_scope(context.scope()).await?;
        if access.execution().session_id != input.parent_session_id {
            return Err("agent_progress_parent_mismatch".into());
        }
    } else {
        owner
            .require_interaction_access(context.scope(), &input.parent_session_id)
            .await?;
    }
    let group = owner.progress.group(&input.parent_session_id);
    let mut changes = group.rows.subscribe();
    let mut updates = Updates::default();
    loop {
        let frame = updates.frame(&changes.borrow_and_update(), Instant::now());
        if let Some(frame) = frame {
            context.emit(encode(frame)?).await?;
        }
        tokio::select! {
            _ = context.scope().cancellation.cancelled() => return Err("agent_observation_cancelled".into()),
            result = changes.changed() => result.map_err(|_| "agent_observation_closed")?,
            _ = async {
                match updates.deadline {
                    Some(until) => tokio::time::sleep_until(until).await,
                    None => std::future::pending::<()>().await,
                }
            } => {}
        }
    }
}
#[derive(Default)]
struct Updates {
    sent: Option<Rows>,
    deadline: Option<Instant>,
}
impl Updates {
    fn frame(&mut self, rows: &Rows, now: Instant) -> Option<WorkerProgressFrame> {
        let snapshot = self.sent.is_none();
        let sent = self.sent.get_or_insert_with(Rows::new);
        let removed = sent.keys().any(|id| !rows.contains_key(id));
        let immediate = snapshot
            || removed
            || rows.values().any(|row| {
                sent.get(&row.session_id).is_none_or(|previous| {
                    previous.run_id != row.run_id
                        || (previous != row
                            && (previous.kind == WorkerProgressKind::Working
                                || waiting(previous.kind)
                                || waiting(row.kind)))
                })
            });
        if !immediate {
            if rows == sent {
                self.deadline = None;
                return None;
            }
            let deadline = self
                .deadline
                .get_or_insert(now + Duration::from_millis(400));
            if now < *deadline {
                return None;
            }
        }
        let upsert = rows
            .values()
            .filter(|row| sent.get(&row.session_id) != Some(row))
            .cloned()
            .collect();
        let remove = sent
            .keys()
            .filter(|id| !rows.contains_key(*id))
            .cloned()
            .collect();
        sent.clone_from(rows);
        self.deadline = None;
        Some(WorkerProgressFrame {
            snapshot,
            upsert,
            remove,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use WorkerProgressKind as Kind;
    #[test]
    fn coalesces_until_deadline_but_delivers_wait_resume_and_removal_immediately() {
        let mut updates = Updates::default();
        let mut rows = Rows::new();
        let now = Instant::now();
        assert!(updates.frame(&rows, now).unwrap().snapshot);
        rows.insert(
            "child".into(),
            WorkerProgress {
                session_id: "child".into(),
                run_id: maka_agent_facts::durable::RunId::new(),
                seq: 0,
                kind: Kind::Working,
                detail: String::new(),
            },
        );
        assert_eq!(updates.frame(&rows, now).unwrap().upsert.len(), 1);
        for (seq, kind, ms, emitted) in [
            (1, Kind::Thinking, 1, true),
            (2, Kind::Generating, 2, false),
            (3, Kind::Command, 380, false),
            (3, Kind::Command, 402, true),
            (4, Kind::Approval, 403, true),
            (5, Kind::Command, 404, true),
        ] {
            let row = rows.get_mut("child").unwrap();
            row.seq = seq;
            row.kind = kind;
            let frame = updates.frame(&rows, now + Duration::from_millis(ms));
            assert_eq!(frame.is_some(), emitted);
            if let Some(frame) = frame {
                assert_eq!(frame.upsert[0].kind, kind);
            }
        }
        assert!(updates.frame(&rows, now + Duration::from_secs(1)).is_none());
        rows.clear();
        assert_eq!(
            updates
                .frame(&rows, now + Duration::from_secs(2))
                .unwrap()
                .remove,
            ["child"]
        );
    }
}

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

//! A watch observation and its consequences share the same root write transaction.
use super::*;
use serde_json::{Value, json};
use tracking::{ACTION_FIELDS, WATCH_FIELDS, action, watch_record};

pub struct ScheduledWatch {
    pub watch: WatchRecord,
    pub authority: Value,
    pub interval_ms: i64,
    pub action_id: Option<ActionId>,
}

pub enum ActionReceipt {
    Returned(Value),
    Unknown(Value),
}

pub enum InputCheck {
    Compared(Vec<String>),
    Unavailable(String),
}

pub struct WatchCheck {
    pub state_hash: String,
    pub matched: bool,
    pub observed_at: UnixMillis,
    pub reason: String,
}

fn insert_watch(
    c: &Connection,
    owner: &str,
    scheduled: &ScheduledWatch,
    due: i64,
) -> Result<(), StoreError> {
    let w = &scheduled.watch;
    let next = w.expires_at.map_or(due, |end| due.min(end.0));
    let sql = "INSERT INTO discovery_watches(owner,watch_id,topic_id,kind,target,predicate_json,on_trigger,
         last_state_hash,expires_at,created_at,updated_at,authority_json,interval_ms,action_id,next_check_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10,?11,?12,?13,?14)";
    c.execute(
        sql,
        params![
            owner,
            w.watch_id.0,
            w.topic_id.0,
            w.kind.as_str(),
            w.target,
            w.predicate.to_string(),
            w.on_trigger.as_str(),
            w.last_state_hash,
            w.expires_at.map(|t| t.0),
            w.created_at.0,
            scheduled.authority.to_string(),
            scheduled.interval_ms,
            scheduled.action_id.as_ref().map(|a| &a.0),
            next,
        ],
    )?;
    Ok(())
}

fn clear_guards(c: &Connection, owner: &str, id: &ActionId) -> Result<(), StoreError> {
    c.execute(
        "DELETE FROM discovery_watches WHERE owner=?1 AND action_id=?2",
        params![owner, id.0],
    )?;
    Ok(())
}

fn material_change(
    c: &Connection,
    owner: &str,
    topic: &TopicId,
    at: UnixMillis,
) -> Result<u64, StoreError> {
    let sql = "UPDATE discovery_dossiers SET signal='red', revision=revision+1,
        last_material_change_at=max(last_material_change_at,?3), updated_at=max(updated_at,?3)
        WHERE owner=?1 AND topic_id=?2 RETURNING revision";
    Ok(c.query_row(sql, params![owner, topic.0, at.0], |r| unsigned(r, 0))?)
}

fn invalidate(
    c: &Connection,
    owner: &str,
    id: &ActionId,
    receipt: &Value,
    at: UnixMillis,
) -> Result<(), StoreError> {
    let sql = "UPDATE discovery_pending_actions SET status='stale',receipt_json=?3,updated_at=max(updated_at,?4)
        WHERE owner=?1 AND action_id=?2 AND status='awaiting_confirm' RETURNING topic_id";
    if let Some(topic) = c
        .query_row(sql, params![owner, id.0, receipt.to_string(), at.0], |r| {
            Ok(TopicId(r.get(0)?))
        })
        .optional()?
    {
        clear_guards(c, owner, id)?;
        material_change(c, owner, &topic, at)?;
    }
    Ok(())
}

impl DiscoveryStore {
    pub async fn register_watch(
        &self,
        watch: ScheduledWatch,
        due: UnixMillis,
    ) -> Result<(), StoreError> {
        self.data
            .write(self.mutation(true, move |c, owner| {
                let sql =
                    "SELECT EXISTS(SELECT 1 FROM discovery_watches WHERE owner=?1 AND watch_id=?2)";
                if c.query_row(sql, params![owner, watch.watch.watch_id.0], |r| {
                    r.get::<_, bool>(0)
                })? {
                    return Ok(());
                }
                insert_watch(c, owner, &watch, due.0)
            }))
            .await
    }

    pub fn stage_action_statement(
        &self,
        action: PendingActionRecord,
        authority: Value,
        read_authority: Value,
    ) -> impl Statement<Value = DiscoveryCommit<()>, Output = ()> + use<> {
        self.mutation(true, move |c, owner| {
            let sql = "INSERT INTO discovery_pending_actions(owner,action_id,topic_id,connector_tool,params_json,input_hashes_json,
                idempotency_key,status,expires_at,created_at,updated_at,authority_json)
                VALUES (?1,?2,?3,?4,?5,?6,?7,'awaiting_confirm',?8,?9,?9,?10)";
            c.execute(sql, params![
                owner,action.action_id.0,action.topic_id.0,action.connector_tool,action.params.to_string(),
                serde_json::to_string(&action.input_hashes)?,action.idempotency_key,action.expires_at.0,
                action.created_at.0,authority.to_string(),
            ])?;
            for (path, hash) in action.input_hashes {
                let guard = ScheduledWatch {
                    watch: WatchRecord {
                        watch_id: WatchId(uuid::Uuid::new_v4().to_string()),
                        topic_id: action.topic_id.clone(),
                        kind: WatchKind::FileHash,
                        target: path,
                        predicate: json!({"expected_hash": hash}),
                        on_trigger: WatchTrigger::InvalidateAction,
                        last_state_hash: Some(hash),
                        expires_at: Some(action.expires_at),
                        created_at: action.created_at,
                        updated_at: action.created_at,
                    },
                    authority: read_authority.clone(),
                    interval_ms: 30_000,
                    action_id: Some(action.action_id.clone()),
                };
                insert_watch(c, owner, &guard, action.created_at.0)?;
            }
            material_change(c, owner, &action.topic_id, action.created_at)?;
            Ok(())
        })
    }

    pub async fn action_for_confirmation(
        &self,
        id: ActionId,
    ) -> Result<Option<(PendingActionRecord, Option<Value>)>, StoreError> {
        self.read(move |c, owner| {
            let sql = format!("SELECT {ACTION_FIELDS},authority_json FROM discovery_pending_actions WHERE owner=?1 AND action_id=?2");
            Ok(c.query_row(&sql, params![owner,id.0], |r| {
                let authority = match r.get_ref(11)? {
                    rusqlite::types::ValueRef::Null => None,
                    _ => Some(json(r,11)?),
                };
                Ok((action(r)?, authority))
            }).optional()?)
        }).await
    }

    /// Claim exactly the version inspected by the caller, with expiry checked inside the transaction.
    pub async fn claim_action(
        &self,
        id: ActionId,
        updated: UnixMillis,
        inputs: InputCheck,
    ) -> Result<bool, StoreError> {
        self.data.write(self.mutation(true, move |c, owner| {
            let at = crate::sql::now()?;
            let sql = "SELECT expires_at FROM discovery_pending_actions WHERE owner=?1 AND action_id=?2
                AND status='awaiting_confirm' AND updated_at=?3";
            let Some(expires) = c.query_row(sql, params![owner,id.0,updated.0], |r| r.get::<_,i64>(0)).optional()? else {
                return Ok(false);
            };
            let stale = match inputs {
                _ if expires <= at.0 => Some(json!({"reason":"expired"})),
                InputCheck::Compared(paths) if !paths.is_empty() => Some(json!({"reason":"changed","changedPaths":paths})),
                InputCheck::Unavailable(error) => Some(json!({"reason":"authorization_unavailable","error":error})),
                InputCheck::Compared(_) => None,
            };
            if let Some(receipt) = stale {
                invalidate(c, owner, &id, &receipt, at)?;
                return Ok(false);
            }
            let sql = "UPDATE discovery_pending_actions SET status='executing',updated_at=max(updated_at,?4)
                WHERE owner=?1 AND action_id=?2 AND status='awaiting_confirm' AND updated_at=?3 AND expires_at>?4";
            Ok(c.execute(sql, params![owner,id.0,updated.0,at.0])? == 1)
        })).await
    }

    pub async fn finish_action(
        &self,
        id: ActionId,
        receipt: ActionReceipt,
        at: UnixMillis,
    ) -> Result<(), StoreError> {
        self.data.write(self.mutation(true, move |c, owner| {
            let (status, receipt) = match receipt {
                ActionReceipt::Returned(receipt) => (PendingActionStatus::Done,receipt),
                ActionReceipt::Unknown(receipt) => (PendingActionStatus::UnknownPendingReceipt,receipt),
            };
            let sql = "UPDATE discovery_pending_actions SET status=?3,receipt_json=?4,updated_at=max(updated_at,?5)
                WHERE owner=?1 AND action_id=?2 AND status='executing'";
            if c.execute(sql, params![owner,id.0,status.as_str(),receipt.to_string(),at.0])? != 1 {
                return Err(crate::store::invalid("discovery_action_not_executing"));
            }
            clear_guards(c, owner, &id)
        })).await
    }

    pub fn dismiss_action_statement(
        &self,
        id: ActionId,
        at: UnixMillis,
    ) -> impl Statement<Value = DiscoveryCommit<()>, Output = ()> + use<> {
        self.mutation(true, move |c, owner| {
            let sql = "UPDATE discovery_pending_actions SET status='done',receipt_json='{\"outcome\":\"dismissed\"}',updated_at=max(updated_at,?3)
                WHERE owner=?1 AND action_id=?2 AND status IN ('awaiting_confirm','stale')";
            if c.execute(sql, params![owner,id.0,at.0])? != 1 {
                return Err(crate::store::invalid("discovery_action_not_dismissible"));
            }
            clear_guards(c, owner, &id)
        })
    }

    pub async fn recover_executing_actions(&self, at: UnixMillis) -> Result<(), StoreError> {
        self.data.write(self.mutation(true, move |c, owner| {
            let cleanup = "DELETE FROM discovery_watches WHERE owner=?1 AND action_id IN
                (SELECT action_id FROM discovery_pending_actions WHERE owner=?1 AND status='executing')";
            c.execute(cleanup, [owner])?;
            let recover = "UPDATE discovery_pending_actions SET status='unknown_pending_receipt',receipt_json=?3,updated_at=max(updated_at,?2)
                WHERE owner=?1 AND status='executing'";
            let receipt = json!({"outcome":"unknown_pending_receipt","error":"Host stopped before recording the receipt"});
            c.execute(recover, params![owner,at.0,receipt.to_string()])?;
            Ok(())
        })).await
    }

    pub async fn expire_actions(&self, at: UnixMillis) -> Result<(), StoreError> {
        self.data.write(self.mutation(true, move |c, owner| {
            let sql = "SELECT action_id FROM discovery_pending_actions WHERE owner=?1 AND status='awaiting_confirm' AND expires_at<=?2 LIMIT 128";
            let mut stmt = c.prepare_cached(sql)?;
            let ids = stmt.query_map(params![owner,at.0], |r| Ok(ActionId(r.get(0)?)))?.collect::<Result<Vec<_>,_>>()?;
            for id in ids { invalidate(c, owner, &id, &json!({"reason":"expired"}), at)?; }
            Ok(())
        })).await
    }

    pub async fn next_action_expiry(&self) -> Result<Option<i64>, StoreError> {
        self.read(|c, owner| {
            let sql = "SELECT min(expires_at) FROM discovery_pending_actions WHERE owner=?1 AND status='awaiting_confirm'";
            Ok(c.query_row(sql, [owner], |r| r.get(0))?)
        }).await
    }

    pub async fn due_watches(
        &self,
        kind: WatchKind,
        at: UnixMillis,
        limit: u32,
    ) -> Result<Vec<ScheduledWatch>, StoreError> {
        self.read(move |c, owner| {
            let sql = format!("SELECT {WATCH_FIELDS},authority_json,interval_ms,action_id FROM discovery_watches
                WHERE owner=?1 AND kind=?2 AND next_check_at<=?3 ORDER BY next_check_at,watch_id LIMIT ?4");
            let mut stmt = c.prepare_cached(&sql)?;
            Ok(stmt.query_map(params![owner,kind.as_str(),at.0,limit], |r| Ok(ScheduledWatch {
                watch: watch_record(r)?,
                authority: json(r,10)?,
                interval_ms: r.get(11)?,
                action_id: r.get::<_,Option<String>>(12)?.map(ActionId),
            }))?.collect::<Result<_,_>>()?)
        }).await
    }

    pub async fn next_watch_due(&self, kind: WatchKind) -> Result<Option<i64>, StoreError> {
        self.read(move |c, owner| {
            let sql = "SELECT min(next_check_at) FROM discovery_watches WHERE owner=?1 AND kind=?2 AND next_check_at IS NOT NULL";
            Ok(c.query_row(sql, params![owner,kind.as_str()], |r| r.get(0))?)
        }).await
    }

    pub async fn file_watch_targets(&self) -> Result<Vec<String>, StoreError> {
        self.read(|c, owner| {
            let mut stmt = c.prepare_cached(
                "SELECT DISTINCT target FROM discovery_watches INDEXED BY discovery_watch_file
                WHERE owner=?1 AND kind='file_hash' AND next_check_at IS NOT NULL",
            )?;
            Ok(stmt
                .query_map([owner], |r| r.get(0))?
                .collect::<Result<_, _>>()?)
        })
        .await
    }

    pub async fn wake_file_watches(
        &self,
        paths: Vec<String>,
        at: UnixMillis,
    ) -> Result<(), StoreError> {
        self.data.write(self.mutation(false, move |c, owner| {
            let sql = "UPDATE discovery_watches SET next_check_at=?3 WHERE owner=?1 AND kind='file_hash'
                AND target=?2 AND next_check_at>?3 AND (expires_at IS NULL OR expires_at>?3)";
            let mut stmt = c.prepare_cached(sql)?;
            for path in paths { stmt.execute(params![owner,path,at.0])?; }
            Ok(())
        })).await
    }

    pub async fn reschedule_watch(&self, id: WatchId, next: Option<i64>) -> Result<(), StoreError> {
        self.data.write(self.mutation(false, move |c, owner| {
            let sql = "UPDATE discovery_watches SET next_check_at=min(?3,coalesce(expires_at,?3)) WHERE owner=?1 AND watch_id=?2";
            c.execute(sql, params![owner,id.0,next])?;
            Ok(())
        })).await
    }

    pub async fn observe_watch(
        &self,
        scheduled: ScheduledWatch,
        check: WatchCheck,
        next: i64,
    ) -> Result<(), StoreError> {
        let w = scheduled.watch;
        let fired = check.matched && w.last_state_hash.as_ref() != Some(&check.state_hash);
        self.data.write(Write {
            owner: self.owner.clone(),
            changes: fired.then(|| self.changed.clone()),
            write: move |c: &Connection, owner: &str| {
                let at = check.observed_at;
                let once = fired && w.kind == WatchKind::Deadline;
                let sql = "UPDATE discovery_watches SET last_state_hash=?4,updated_at=max(updated_at,?5),
                    next_check_at=CASE WHEN ?7 THEN NULL ELSE min(?6,coalesce(expires_at,?6)) END,
                    expires_at=CASE WHEN ?7 THEN ?5 ELSE expires_at END,
                    followup_at=CASE WHEN ?8 THEN ?5 ELSE followup_at END
                    WHERE owner=?1 AND watch_id=?2 AND last_state_hash IS ?3 AND (expires_at IS NULL OR expires_at>?5)";
                let count = c.execute(sql, params![owner,w.watch_id.0,w.last_state_hash,check.state_hash,at.0,next,once,
                    fired && w.on_trigger==WatchTrigger::EnqueueFollowup])?;
                if count == 0 { return Ok(((),None)); }
                c.execute("UPDATE discovery_dossiers SET last_checked_at=max(last_checked_at,?3) WHERE owner=?1 AND topic_id=?2",
                    params![owner,w.topic_id.0,at.0])?;
                if fired {
                    match w.on_trigger {
                        WatchTrigger::NotifyDirect => {
                            let rev = material_change(c, owner, &w.topic_id, at)?;
                            return Ok(((),notify(c,owner,&w.topic_id,rev,check.reason,at)?));
                        }
                        WatchTrigger::InvalidateAction => {
                            let receipt = if w.kind == WatchKind::FileHash { json!({"reason":"changed","changedPaths":[w.target]}) }
                                else { json!({"reason":"watch","watchId":w.watch_id}) };
                            if let Some(id) = scheduled.action_id {
                                invalidate(c,owner,&id,&receipt,at)?;
                            } else {
                                let sql = "SELECT action_id FROM discovery_pending_actions WHERE owner=?1 AND topic_id=?2 AND status='awaiting_confirm'
                                    AND (?3!='file_hash' OR EXISTS(SELECT 1 FROM json_each(input_hashes_json) WHERE key=?4 AND value!=?5))";
                                let mut stmt = c.prepare_cached(sql)?;
                                let ids = stmt.query_map(params![owner,w.topic_id.0,w.kind.as_str(),w.target,check.state_hash], |r| Ok(ActionId(r.get(0)?)))?
                                    .collect::<Result<Vec<_>,_>>()?;
                                for id in ids { invalidate(c,owner,&id,&receipt,at)?; }
                            }
                        }
                        WatchTrigger::EnqueueFollowup => {}
                    }
                }
                Ok(((),None))
            },
        }).await
    }

    pub async fn pending_watch_followups(
        &self,
    ) -> Result<Vec<(WatchId, TopicId, UnixMillis, Value)>, StoreError> {
        self.read(|c, owner| {
            let sql = "SELECT watch_id,topic_id,followup_at,authority_json FROM discovery_watches
                WHERE owner=?1 AND followup_at IS NOT NULL ORDER BY followup_at,watch_id";
            let mut stmt = c.prepare_cached(sql)?;
            Ok(stmt
                .query_map([owner], |r| {
                    Ok((
                        WatchId(r.get(0)?),
                        TopicId(r.get(1)?),
                        UnixMillis(r.get(2)?),
                        json(r, 3)?,
                    ))
                })?
                .collect::<Result<_, _>>()?)
        })
        .await
    }

    pub fn acknowledge_followup(
        &self,
        id: WatchId,
        at: UnixMillis,
    ) -> impl Statement<Value = DiscoveryCommit<()>, Output = ()> + use<> {
        self.mutation(false, move |c, owner| {
            let sql = "UPDATE discovery_watches SET followup_at=NULL WHERE owner=?1 AND watch_id=?2 AND followup_at=?3";
            if c.execute(sql, params![owner,id.0,at.0])? != 1 {
                return Err(crate::store::invalid("discovery_followup_changed"));
            }
            Ok(())
        })
    }
}

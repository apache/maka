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

use super::invalid;
use crate::{
    StoreError,
    bundle::format::{Copy, Record},
};
use maka_agent_facts::session::CopyPurpose;
use maka_agent_facts::session::CopyState;
use maka_agent_facts::session::Lineage;
use sqlx::SqliteConnection;
use std::collections::{BTreeMap, VecDeque};

pub(super) struct Copies(VecDeque<Copy>);

impl Copies {
    pub async fn read(
        staged: &mut SqliteConnection,
        fence: u64,
        positions: Option<&crate::bundle::relocation::Positions>,
    ) -> Result<Self, StoreError> {
        let mut copies = Vec::new();
        let mut after = 0i64;
        loop {
            let row: Option<(i64,String)> = sqlx::query_as(
                "SELECT number,record_json FROM frames WHERE kind='copy' AND number>? ORDER BY number LIMIT 1"
            ).bind(after).fetch_optional(&mut *staged).await?;
            let Some((number, json)) = row else {
                break;
            };
            let Record::Copy(mut copy) = serde_json::from_str(&json)? else {
                unreachable!()
            };
            shape(&copy, fence)?;
            if let Some(positions) = positions {
                copy.through = positions.fence(copy.through);
                copy.observed_through = positions.fence(copy.observed_through);
            }
            copies.push(copy);
            after = number;
        }
        let indexes: BTreeMap<_, _> = copies
            .iter()
            .enumerate()
            .map(|(index, copy)| (copy.request.target_session_id.as_str(), index))
            .collect();
        let mut children = vec![Vec::new(); copies.len()];
        let mut ready = VecDeque::new();
        for (index, copy) in copies.iter().enumerate() {
            if let Some(parent) = indexes.get(copy.request.source_session_id.as_str()) {
                if copies[*parent].observed_through > copy.observed_through {
                    return Err(invalid("copy source did not exist at its observed fence"));
                }
                children[*parent].push(index);
            } else {
                ready.push_back(index);
            }
        }
        let mut visited = 0;
        while let Some(index) = ready.pop_front() {
            visited += 1;
            ready.extend(children[index].iter().copied());
        }
        if visited != copies.len() {
            return Err(invalid("bundle copy ancestry contains a cycle"));
        }
        copies.sort_by_key(|copy| copy.observed_through);
        Ok(Self(copies.into()))
    }

    pub async fn install(
        &mut self,
        staged: &mut SqliteConnection,
        db: &mut SqliteConnection,
        through: u64,
        positions: Option<&crate::bundle::relocation::Positions>,
    ) -> Result<(), StoreError> {
        let mut installed = Vec::new();
        while self
            .0
            .front()
            .is_some_and(|copy| copy.observed_through <= through)
        {
            let copy = self.0.pop_front().expect("eligible copy");
            let request = &copy.request;
            installed.push((
                request.target_session_id.clone(),
                request.source_session_id.clone(),
                copy.through,
            ));
            sqlx::query("INSERT INTO session_history_copies(session_id,source_session_id,source_revision,through_sequence,observed_through,request_json,lineage_json,state) VALUES(?,?,?,?,?,?,?,?)")
                .bind(&request.target_session_id)
                .bind(&request.source_session_id)
                .bind(request.expected_source_revision as i64)
                .bind(copy.through as i64)
                .bind(copy.observed_through as i64)
                .bind(serde_json::to_string(request)?)
                .bind(serde_json::to_string(&copy.lineage)?)
                .bind(copy.state.as_str())
                .execute(&mut *db)
                .await?;
            let mut after = 0i64;
            loop {
                let row: Option<(i64,String)> = sqlx::query_as(
                    "SELECT number,record_json FROM frames WHERE kind IN ('member','revision_source')
                     AND json_extract(record_json,'$.session')=? AND number>? ORDER BY number LIMIT 1"
                ).bind(&request.target_session_id).bind(after).fetch_optional(&mut *staged).await?;
                let Some((number, json)) = row else {
                    break;
                };
                match serde_json::from_str(&json)? {
                    Record::Member {
                        session,
                        sequence,
                        archive_sequence,
                    } => {
                        let sequence = positions.map_or(Ok(sequence), |p| p.event(sequence))?;
                        let archive_sequence = archive_sequence
                            .map(|n| positions.map_or(Ok(n), |p| p.event(n)))
                            .transpose()?;
                        if sequence > copy.through
                            || archive_sequence.is_some_and(|a| a > copy.observed_through)
                        {
                            return Err(invalid("copy member exceeds its original fence"));
                        }
                        sqlx::query("INSERT INTO session_history_members VALUES(?,?,?)")
                            .bind(session)
                            .bind(sequence as i64)
                            .bind(archive_sequence.map(|n| n as i64))
                            .execute(&mut *db)
                            .await?;
                    }
                    Record::RevisionSource { session, sequence } => {
                        let sequence = positions.map_or(Ok(sequence), |p| p.event(sequence))?;
                        let CopyPurpose::Revision { turn_id } = &request.purpose else {
                            return Err(invalid("revision evidence requires a Revision copy"));
                        };
                        if sequence > copy.observed_through {
                            return Err(invalid("revision source exceeds its original fence"));
                        }
                        let selected: bool = sqlx::query_scalar(
                            "SELECT EXISTS(SELECT 1 FROM runtime_events WHERE sequence=?
                             AND json_extract(event_json,'$.invocation.turn_id')=?
                             AND ((kind='invocation_opened'
                               AND json_extract(event_json,'$.fact.input.kind')='message'
                               AND json_array_length(event_json,'$.fact.input.source_messages')>0)
                               OR kind='message_steered'))",
                        )
                        .bind(sequence as i64)
                        .bind(turn_id)
                        .fetch_one(&mut *db)
                        .await?;
                        if !selected {
                            return Err(invalid(
                                "revision source is not a selected canonical Message input",
                            ));
                        }
                        sqlx::query("INSERT INTO session_revision_sources VALUES(?,?)")
                            .bind(session)
                            .bind(sequence as i64)
                            .execute(&mut *db)
                            .await?;
                    }
                    _ => unreachable!(),
                }
                after = number;
            }
        }
        // Equal-fence copies need not be ordered by ancestry in a bundle.
        // Validate the full incoming membership once, then pin shared roots.
        for (target, source, through) in installed {
            let differs: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT sequence FROM session_history_events
                   WHERE owner_session_id=?1 AND sequence<=?2
                   EXCEPT SELECT sequence FROM session_history_members WHERE session_id=?3)
                 OR EXISTS(SELECT sequence FROM session_history_members WHERE session_id=?3
                   EXCEPT SELECT sequence FROM session_history_events
                   WHERE owner_session_id=?1 AND sequence<=?2)",
            )
            .bind(source)
            .bind(through as i64)
            .bind(&target)
            .fetch_one(&mut *db)
            .await?;
            if differs {
                return Err(invalid(
                    "copy membership differs from its complete source prefix",
                ));
            }
            sqlx::query("SELECT context_source_pin_copy(?)")
                .bind(target)
                .execute(&mut *db)
                .await?;
        }
        Ok(())
    }
}

fn shape(copy: &Copy, fence: u64) -> Result<(), StoreError> {
    let r = &copy.request;
    for id in [&r.source_session_id, &r.target_session_id] {
        crate::sessions::validate_id(id)?;
    }
    if r.source_session_id == r.target_session_id
        || copy.state == CopyState::Abandoned
        || r.expected_source_revision == 0
        || r.expected_source_revision > 9_007_199_254_740_991
        || copy.through > copy.observed_through
        || copy.observed_through > fence
    {
        return Err(invalid("invalid original copy boundary"));
    }
    match (&r.purpose, &copy.lineage) {
        (CopyPurpose::Branch { turn_id, .. }, Lineage::Branch { origin })
            if origin.parent_session_id == r.source_session_id && &origin.turn_id == turn_id =>
        {
            if let Some(id) = turn_id {
                crate::sessions::validate_id(id)?;
            }
        }
        (CopyPurpose::EmptySideConversation, Lineage::Branch { origin })
            if copy.through == 0
                && origin.parent_session_id == r.source_session_id
                && origin.turn_id.is_none() => {}
        (
            CopyPurpose::Revision { turn_id },
            Lineage::Revision {
                root_session_id,
                parent_session_id,
                turn_id: target,
                index,
                branch,
            },
        ) if parent_session_id == &r.source_session_id
            && target == turn_id
            && *index >= 2
            && *index <= 9_007_199_254_740_991 =>
        {
            crate::sessions::validate_id(root_session_id)?;
            crate::sessions::validate_id(turn_id)?;
            if let Some(branch) = branch {
                crate::sessions::validate_id(&branch.parent_session_id)?;
                if let Some(id) = &branch.turn_id {
                    crate::sessions::validate_id(id)?;
                }
            }
        }
        _ => return Err(invalid("copy provenance differs from its request")),
    }
    Ok(())
}

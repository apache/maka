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

use super::{Admission, ContentBlob, Store};
use crate::{
    queue::{Consume, DeliveryTarget, Event},
    sql,
};
use maka_agent_facts::{artifact::content_digest, durable::*};
use maka_event_log::{StoreError, connection::Query};
use rusqlite::{Connection, OptionalExtension, params};
use serde::de::DeserializeOwned;

impl Store {
    /// Observe the original admission after the Root FIFO barrier; this never
    /// admits work, consumes queue input or rechecks today's execution authority.
    pub async fn admission_recorded(&self, admission: &Admission) -> Result<bool, StoreError> {
        let spec_ref = ContentBlob::json(&admission.spec)?.reference().clone();
        self.data
            .query_barrier(ReadAdmission {
                run: admission.run,
                id: admission.id,
                spec: admission.spec.clone(),
                spec_ref,
                at: admission.at,
                queue: admission.queue.clone(),
            })
            .await
    }
}

struct ReadAdmission {
    run: RunId,
    id: FactId,
    spec: RunSpec,
    spec_ref: ContentRef,
    at: UnixMillis,
    queue: Option<Consume>,
}

fn original<T: DeserializeOwned>(
    c: &Connection,
    content: i64,
    reference: &ContentRef,
) -> Result<T, StoreError> {
    let row: Option<(String, Vec<u8>)> = c
        .query_row(
            "SELECT content_sha256,payload FROM contents WHERE id=?",
            [content],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let (digest, bytes) = row.ok_or(StoreError::EventConflict)?;
    if digest != reference.digest
        || u64::try_from(bytes.len()).ok() != Some(reference.bytes)
        || content_digest(&bytes) != reference.digest
    {
        return Err(StoreError::EventConflict);
    }
    serde_json::from_slice(&bytes).map_err(|_| StoreError::EventConflict)
}

fn reference(c: &Connection, content: i64) -> Result<ContentRef, StoreError> {
    let row: Option<(String, i64)> = c
        .query_row(
            "SELECT content_sha256,length(payload) FROM contents WHERE id=?",
            [content],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let (digest, bytes) = row.ok_or(StoreError::EventConflict)?;
    let reference = ContentRef {
        digest,
        bytes: u64::try_from(bytes).map_err(|_| StoreError::EventConflict)?,
    };
    reference
        .validate()
        .map_err(|_| StoreError::EventConflict)?;
    Ok(reference)
}

impl Query for ReadAdmission {
    type Output = bool;

    fn execute(self, c: &Connection) -> Result<bool, StoreError> {
        if self.spec.schema_version != SCHEMA_VERSION {
            return Err(StoreError::EventConflict);
        }
        let spec: Option<(i64, String, String, i64)> = c.query_row(
            "SELECT schema_version,owner,session,spec_content_id FROM agent_run_specs WHERE run=?",
            [self.run.to_string()], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).optional()?;
        // FactId is global: a same UUID in a foreign Run is a conflict, not absence.
        let fact: Option<(String, i64, i64, i64, i64)> = c
            .query_row(
                "SELECT run,revision,schema_version,at,body_content_id FROM agent_facts WHERE id=?",
                [self.id.to_string()],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()?;
        let any_run_fact: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_facts WHERE run=?)",
            [self.run.to_string()],
            |row| row.get(0),
        )?;
        let queued: Option<(i64, i64, i64)> = c.query_row(
            "SELECT revision,at,body_content_id FROM agent_queue_events WHERE session=? AND id=?",
            params![self.spec.session_id, self.id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional()?;
        if spec.is_none() && fact.is_none() && !any_run_fact && queued.is_none() {
            return Ok(false);
        }
        let (schema, owner, session, spec_content) = spec.ok_or(StoreError::EventConflict)?;
        if schema != i64::from(SCHEMA_VERSION)
            || session != self.spec.session_id
            || serde_json::from_str::<RunOwner>(&owner).map_err(|_| StoreError::EventConflict)?
                != self.spec.owner
            || reference(c, spec_content)? != self.spec_ref
        {
            return Err(StoreError::EventConflict);
        }
        let stored_spec: RunSpec = original(c, spec_content, &self.spec_ref)?;
        if stored_spec != self.spec {
            return Err(StoreError::EventConflict);
        }
        let (run, revision, schema, at, body_content) = fact.ok_or(StoreError::EventConflict)?;
        if run != self.run.to_string()
            || revision != 1
            || schema != i64::from(SCHEMA_VERSION)
            || at != self.at.0
        {
            return Err(StoreError::EventConflict);
        }
        let expected = RecordedFact {
            schema_version: SCHEMA_VERSION,
            id: self.id,
            run: self.run,
            revision: 1,
            at: self.at,
            fact: Fact::RunAdmitted {
                spec: self.spec_ref,
            },
        };
        let body_ref = ContentBlob::json(&expected)?.reference().clone();
        if reference(c, body_content)? != body_ref {
            return Err(StoreError::EventConflict);
        }
        let stored = sql::fact(c, self.run, self.id)
            .map_err(|error| match error {
                StoreError::Json(_) | StoreError::InvalidTransition(_) => StoreError::EventConflict,
                error => error,
            })?
            .ok_or(StoreError::EventConflict)?;
        if stored != expected {
            return Err(StoreError::EventConflict);
        }
        match (self.queue, queued) {
            (None, None) => {}
            (Some(cut), Some((revision, at, content))) => {
                let expected_revision = cut
                    .expected_revision
                    .checked_add(1)
                    .and_then(|revision| i64::try_from(revision).ok())
                    .ok_or(StoreError::EventConflict)?;
                if cut.session != session || revision != expected_revision || at != self.at.0 {
                    return Err(StoreError::EventConflict);
                }
                let expected = Event::Consumed {
                    cut,
                    run: self.run,
                    target: DeliveryTarget::Run,
                };
                let expected_ref = ContentBlob::json(&expected)?.reference().clone();
                if reference(c, content)? != expected_ref {
                    return Err(StoreError::EventConflict);
                }
                let stored: Event = original(c, content, &expected_ref)?;
                if stored != expected {
                    return Err(StoreError::EventConflict);
                }
            }
            _ => return Err(StoreError::EventConflict),
        }
        Ok(true)
    }
}

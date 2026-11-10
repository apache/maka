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

//! Auxiliary model evidence is admitted once at its original canonical source.
use super::*;
use maka_agent_facts::{
    accounting::{AuxiliarySource, Outcome},
    artifact::content_digest,
    language::Language,
    model::ModelUsage,
};
use maka_event_log::{
    applications::operations::OperationRequest,
    connection::Query,
    content,
    writeback::{Notification, Prepared, Statement},
};
use maka_plugin_core::{contract::Contract, operation::RecoveryContract};
use rusqlite::{Connection, OptionalExtension, params};
use std::sync::Arc;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuxiliarySpec {
    pub schema_version: u32,
    pub owner: RunOwner,
    pub session: String,
    pub source: AuxiliarySource,
    pub accounting: ModelEvidence,
    pub language: Language,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AuxiliaryEvent {
    Started { spec: ContentRef },
    UsageObserved { usage: ModelUsage },
    Settled { outcome: Outcome },
}

/// Original immutable inputs, not a serialized claim or permission to dispatch.
#[derive(Clone)]
pub struct AuxiliaryWrite {
    id: Uuid,
    request: Uuid,
    at: UnixMillis,
    body: Arc<[u8]>,
    spec: Option<Arc<[u8]>>,
}
impl AuxiliaryWrite {
    pub(super) fn new(
        request: Uuid,
        at: UnixMillis,
        event: AuxiliaryEvent,
        spec: Option<Arc<[u8]>>,
    ) -> Self {
        Self {
            id: Uuid::new_v4(),
            request,
            at,
            body: serde_json::to_vec(&event)
                .expect("closed auxiliary event is JSON serializable")
                .into(),
            spec,
        }
    }
}
#[derive(Clone)]
pub struct AuxiliaryJournal {
    data: DataWriter,
    request: Uuid,
}
impl UsageStore {
    /// Rebuild only this auxiliary request's derived accounting from retained canonical bytes.
    pub async fn rebuild_auxiliary(&self, request: Uuid) -> Result<(), Error> {
        self.data.write(RebuildAuxiliary(request)).await?;
        Ok(())
    }
    pub fn auxiliary(
        &self,
        spec: AuxiliarySpec,
        at: UnixMillis,
    ) -> Result<(AuxiliaryJournal, AuxiliaryWrite), Error> {
        validate_spec(&spec).map_err(|e| Error::Invalid(e.to_string()))?;
        validate_time(at).map_err(|e| Error::Invalid(e.to_string()))?;
        let bytes: Arc<[u8]> = serde_json::to_vec(&spec).map_err(StoreError::from)?.into();
        let reference = ContentRef {
            digest: content_digest(&bytes),
            bytes: u64::try_from(bytes.len())
                .map_err(|_| invalid("auxiliary specification size overflow"))?,
        };
        let request = Uuid::new_v4();
        Ok((
            AuxiliaryJournal {
                data: self.data.clone(),
                request,
            },
            AuxiliaryWrite::new(
                request,
                at,
                AuxiliaryEvent::Started { spec: reference },
                Some(bytes),
            ),
        ))
    }
}
impl AuxiliaryJournal {
    pub fn id(&self) -> Uuid {
        self.request
    }
    pub fn usage(&self, usage: ModelUsage, at: UnixMillis) -> AuxiliaryWrite {
        AuxiliaryWrite::new(
            self.request,
            at,
            AuxiliaryEvent::UsageObserved { usage },
            None,
        )
    }
    pub fn settlement(&self, outcome: Outcome, at: UnixMillis) -> AuxiliaryWrite {
        AuxiliaryWrite::new(self.request, at, AuxiliaryEvent::Settled { outcome }, None)
    }
    pub async fn append(&self, write: AuxiliaryWrite) -> Result<(), Error> {
        self.check(&write)?;
        self.data.write(write).await?
    }
    pub async fn contains(&self, write: &AuxiliaryWrite) -> Result<bool, Error> {
        self.check(write)?;
        Ok(self.data.query_barrier(Contains(write.clone())).await?)
    }
    fn check(&self, write: &AuxiliaryWrite) -> Result<(), Error> {
        if write.request != self.request {
            return Err(Error::Invalid("foreign auxiliary write".into()));
        }
        Ok(())
    }
}
struct Contains(AuxiliaryWrite);
impl Query for Contains {
    type Output = bool;
    fn execute(self, c: &Connection) -> Result<bool, StoreError> {
        contains(c, &self.0)
    }
}

fn validate_time(at: UnixMillis) -> Result<(), StoreError> {
    if at.0 < 0 {
        Err(invalid("auxiliary timestamp precedes epoch"))
    } else {
        Ok(())
    }
}
fn validate_spec(spec: &AuxiliarySpec) -> Result<(), StoreError> {
    if spec.schema_version != SCHEMA_VERSION
        || spec.owner.deployment.is_nil()
        || spec.session.is_empty()
        || spec.session.chars().any(char::is_control)
    {
        return Err(invalid("invalid auxiliary specification"));
    }
    spec.owner
        .namespace
        .validate()
        .map_err(|e| invalid(e.to_string()))?;
    spec.accounting.validate().map_err(invalid)?;
    match &spec.source {
        AuxiliarySource::SessionTitle { execution } | AuxiliarySource::Agent { execution, .. }
            if execution.session_id != spec.session =>
        {
            return Err(invalid("auxiliary source Session differs"));
        }
        AuxiliarySource::Agent { operation_id, .. }
            if operation_id.is_empty() || operation_id.chars().any(char::is_control) =>
        {
            return Err(invalid("invalid auxiliary Agent operation"));
        }
        AuxiliarySource::HostEffect { .. } => {
            return Err(invalid(
                "auxiliary HostEffect source has no supported owner provenance",
            ));
        }
        _ => {}
    }
    Ok(())
}
pub(super) fn source_key(spec: &AuxiliarySpec) -> Result<String, StoreError> {
    Ok(content_digest(&serde_json::to_vec(&(
        "maka.auxiliary.source",
        &spec.owner,
        &spec.source,
    ))?))
}
fn verified(digest: Option<String>, bytes: Option<Vec<u8>>) -> Result<Vec<u8>, StoreError> {
    let digest = digest.ok_or_else(|| invalid("missing auxiliary content digest"))?;
    let bytes = bytes.ok_or_else(|| invalid("missing auxiliary content bytes"))?;
    if content_digest(&bytes) != digest {
        return Err(invalid("corrupt auxiliary content"));
    }
    Ok(bytes)
}
fn contains(c: &Connection, write: &AuxiliaryWrite) -> Result<bool, StoreError> {
    let row: Option<(String, i64, Option<String>, Option<Vec<u8>>)> = c
        .query_row(
            "SELECT e.request,e.at,b.content_sha256,b.payload FROM agent_usage_aux_events e
         LEFT JOIN contents b ON b.id=e.body_content_id WHERE e.id=?",
            [write.id.to_string()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((request, at, digest, bytes)) = row else {
        return Ok(false);
    };
    let bytes = verified(digest, bytes)?;
    if request != write.request.to_string()
        || at != write.at.0
        || bytes.as_slice() != write.body.as_ref()
    {
        return Err(StoreError::EventConflict);
    }
    Ok(true)
}
fn stored_spec(c: &Connection, request: Uuid) -> Result<AuxiliarySpec, StoreError> {
    let (owner,session,key,digest,bytes): (String,String,String,Option<String>,Option<Vec<u8>>) = c.query_row(
        "SELECT s.owner,s.session,s.source_key,b.content_sha256,b.payload FROM agent_usage_aux_specs s
         LEFT JOIN contents b ON b.id=s.spec_content_id WHERE s.request=?",
        [request.to_string()], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)),
    ).optional()?.ok_or_else(|| invalid("auxiliary request was not started"))?;
    let spec: AuxiliarySpec = serde_json::from_slice(&verified(digest, bytes)?)?;
    validate_spec(&spec)?;
    if serde_json::to_string(&spec.owner)? != owner
        || spec.session != session
        || source_key(&spec)? != key
    {
        return Err(invalid("auxiliary specification index differs"));
    }
    Ok(spec)
}
fn put(c: &Connection, bytes: &[u8]) -> Result<i64, StoreError> {
    let digest = content_digest(bytes);
    if let Some(original) = content::read(c, &digest)?
        && original != bytes
    {
        return Err(invalid("auxiliary immutable content differs"));
    }
    content::put(c, &digest, bytes)
}

impl Statement for AuxiliaryWrite {
    type Value = Result<(), Error>;
    type Output = Result<(), Error>;
    fn execute(self, c: &Connection) -> Result<Prepared<Self::Value>, StoreError> {
        validate_time(self.at)?;
        if contains(c, &self)? {
            return Ok(Prepared {
                value: Ok(()),
                changed: false,
                notification: Notification::NONE,
            });
        }
        let event: AuxiliaryEvent = serde_json::from_slice(&self.body)?;
        let spec = match &event {
            AuxiliaryEvent::Started { spec: reference } => {
                let bytes = self
                    .spec
                    .as_ref()
                    .ok_or_else(|| invalid("auxiliary Started specification missing"))?;
                if reference.digest != content_digest(bytes)
                    || usize::try_from(reference.bytes).ok() != Some(bytes.len())
                {
                    return Err(invalid("auxiliary Started specification differs"));
                }
                let spec: AuxiliarySpec = serde_json::from_slice(bytes)?;
                validate_spec(&spec)?;
                let key = source_key(&spec)?;
                let existing: Option<String> = c
                    .query_row(
                        "SELECT request FROM agent_usage_aux_specs WHERE source_key=?",
                        [&key],
                        |r| r.get(0),
                    )
                    .optional()?;
                if let Some(request) = existing {
                    let request = Uuid::parse_str(&request).map_err(|e| invalid(e.to_string()))?;
                    if request == self.request {
                        return Err(StoreError::EventConflict);
                    }
                    return Ok(Prepared {
                        value: Err(Error::SourceAlreadyAdmitted { request }),
                        changed: false,
                        notification: Notification::NONE,
                    });
                }
                validate_source(c, &spec)?;
                let content_id = put(c, bytes)?;
                c.execute("INSERT INTO agent_usage_aux_specs(request,owner,session,source_key,spec_content_id) VALUES(?,?,?,?,?)",
                    params![self.request.to_string(),serde_json::to_string(&spec.owner)?,spec.session,key,content_id])?;
                spec
            }
            AuxiliaryEvent::UsageObserved { .. } | AuxiliaryEvent::Settled { .. } => {
                let spec = stored_spec(c, self.request)?;
                let (digest,bytes): (Option<String>,Option<Vec<u8>>) = c.query_row(
                    "SELECT b.content_sha256,b.payload FROM agent_usage_aux_events e
                     LEFT JOIN contents b ON b.id=e.body_content_id WHERE e.request=? ORDER BY e.sequence DESC LIMIT 1",
                    [self.request.to_string()], |r| Ok((r.get(0)?,r.get(1)?)),
                ).optional()?.ok_or_else(|| invalid("auxiliary request has no Started event"))?;
                if matches!(
                    serde_json::from_slice::<AuxiliaryEvent>(&verified(digest, bytes)?)?,
                    AuxiliaryEvent::Settled { .. }
                ) {
                    return Err(invalid("auxiliary request is already settled"));
                }
                spec
            }
        };
        let body = put(c, &self.body)?;
        c.execute(
            "INSERT INTO agent_usage_aux_events(id,request,at,body_content_id) VALUES(?,?,?,?)",
            params![
                self.id.to_string(),
                self.request.to_string(),
                self.at.0,
                body
            ],
        )?;
        let sequence = unsigned(c.last_insert_rowid())?;
        super::index::index_auxiliary(c, self.request, sequence, self.at, &event, &spec)?;
        Ok(Prepared {
            value: Ok(()),
            changed: true,
            notification: Notification::METADATA.with_sessions([spec.session]),
        })
    }
    fn committed(value: Self::Value) -> Self::Output {
        value
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(
            error,
            StoreError::InvalidTransition(_) | StoreError::EventConflict
        )
    }
}

fn validate_source(c: &Connection, spec: &AuxiliarySpec) -> Result<(), StoreError> {
    match &spec.source {
        AuxiliarySource::Agent { execution, .. } | AuxiliarySource::SessionTitle { execution } => {
            let (owner,session,version,digest,bytes): (String,String,u32,Option<String>,Option<Vec<u8>>) = c.query_row(
                "SELECT r.owner,r.session,r.schema_version,b.content_sha256,b.payload FROM agent_run_specs r
                 LEFT JOIN contents b ON b.id=r.spec_content_id WHERE r.run=?",
                [execution.run_id.to_string()], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)),
            ).optional()?.ok_or_else(|| invalid("auxiliary source Run missing"))?;
            let run: RunSpec = serde_json::from_slice(&verified(digest, bytes)?)?;
            if version != maka_agent_facts::durable::SCHEMA_VERSION
                || run.schema_version != version
                || owner != serde_json::to_string(&spec.owner)?
                || session != spec.session
                || run.owner != spec.owner
                || run.session_id != spec.session
                || run.turn_id != execution.turn_id
            {
                return Err(invalid("auxiliary source Run provenance differs"));
            }
        }
        AuxiliarySource::ApplicationOperation {
            source,
            namespace,
            operation,
            fingerprint,
        } => {
            let (revision,contract_digest,request,contract): (i64,String,String,String) = c.query_row(
                "SELECT o.source_revision,o.contract_digest,o.request_json,k.contract_json FROM application_operations o
                 JOIN application_operation_contracts k ON k.digest=o.contract_digest
                 WHERE o.deployment=? AND o.namespace=? AND o.operation=?",
                params![source.deployment.to_string(),serde_json::to_string(namespace)?,operation.to_string()],
                |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)),
            ).optional()?.ok_or_else(|| invalid("auxiliary original operation or contract missing"))?;
            let original: OperationRequest<RecoveryContract> = serde_json::from_str(&request)?;
            let contract: Contract = serde_json::from_str(&contract)?;
            let captured_contract = original.contract;
            let reference = OperationRequest {
                source: original.source,
                namespace: original.namespace,
                consumer: original.consumer,
                export: original.export,
                method: original.method,
                contract,
                operation: original.operation,
                input: original.input,
                capture: original.capture,
                origin: original.origin,
            }
            .reference()?;
            if reference.source != *source
                || reference.namespace != *namespace
                || reference.operation != *operation
                || reference.fingerprint != *fingerprint
                || reference.contract != captured_contract
                || reference.contract.digest != contract_digest
                || unsigned(revision)? != source.revision
            {
                return Err(invalid("auxiliary original operation descriptor differs"));
            }
        }
        AuxiliarySource::HostEffect { .. } => {
            return Err(invalid("unsupported auxiliary HostEffect source"));
        }
    }
    Ok(())
}

pub(super) struct RebuildAuxiliary(pub(super) Uuid);
impl Statement for RebuildAuxiliary {
    type Value = ();
    type Output = ();
    fn execute(self, c: &Connection) -> Result<Prepared<()>, StoreError> {
        let spec = stored_spec(c, self.0)?;
        let (digest, bytes): (String, i64) = c.query_row(
            "SELECT b.content_sha256,length(b.payload) FROM agent_usage_aux_specs s
             JOIN contents b ON b.id=s.spec_content_id WHERE s.request=?",
            [self.0.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let expected = ContentRef {
            digest,
            bytes: unsigned(bytes)?,
        };
        c.execute(
            "DELETE FROM agent_usage_calls WHERE request=? AND source='auxiliary'",
            [format!("auxiliary:{}", self.0)],
        )?;
        let mut after = 0i64;
        let mut started = false;
        let mut settled = false;
        loop {
            let page: Vec<(i64,i64,Option<String>,Option<Vec<u8>>)> = c.prepare_cached(
                "SELECT e.sequence,e.at,b.content_sha256,b.payload FROM agent_usage_aux_events e
                 LEFT JOIN contents b ON b.id=e.body_content_id
                 WHERE e.request=? AND e.sequence>? ORDER BY e.sequence LIMIT 128"
            )?.query_map(params![self.0.to_string(),after], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)))?
                .collect::<Result<_,_>>()?;
            if page.is_empty() {
                break;
            }
            for (sequence, at, digest, bytes) in page {
                let event: AuxiliaryEvent = serde_json::from_slice(&verified(digest, bytes)?)?;
                let at = UnixMillis(at);
                validate_time(at)?;
                match &event {
                    AuxiliaryEvent::Started { spec } if !started && spec == &expected => {
                        started = true
                    }
                    AuxiliaryEvent::UsageObserved { .. } if started && !settled => {}
                    AuxiliaryEvent::Settled { .. } if started && !settled => settled = true,
                    _ => return Err(invalid("invalid canonical auxiliary lifecycle")),
                }
                super::index::index_auxiliary(c, self.0, unsigned(sequence)?, at, &event, &spec)?;
                after = sequence;
            }
        }
        if !started {
            return Err(invalid("canonical auxiliary Started event missing"));
        }
        Ok(Prepared {
            value: (),
            changed: true,
            notification: Notification::METADATA.with_sessions([spec.session]),
        })
    }
    fn committed(_: ()) {}
    fn isolated_rejection(error: &StoreError) -> bool {
        AuxiliaryWrite::isolated_rejection(error)
    }
}

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
use maka_agent_facts::{executor::NATIVE_TASK_PROTOCOL, tool_output::ToolOutput};
use rusqlite::{Connection, OptionalExtension, params};

pub(crate) struct MissingReturns {
    pub owner: RunOwner,
    pub session: String,
    pub binding: uuid::Uuid,
}

impl maka_event_log::connection::Query for MissingReturns {
    type Output = Vec<MissingReturn>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let mut statement = c.prepare_cached(
            "SELECT e.run,e.task,e.operation,json_extract(e.body,'$.missingReturn')
             FROM agent_external_effects e INDEXED BY agent_external_missing_returns
             CROSS JOIN agent_run_specs r ON r.run=e.run JOIN contents s ON s.id=r.spec_content_id
             WHERE e.pending=1 AND json_extract(e.body,'$.missingReturn') IS NOT NULL
             AND r.owner=? AND r.session=? AND json_extract(maka_content_text(s.payload,s.encoding),'$.permissionBasis.binding.id')=?
             ORDER BY e.run,e.operation")?;
        let mut rows = statement.query(params![
            serde_json::to_string(&self.owner)?,
            self.session,
            self.binding.to_string()
        ])?;
        let mut calls = Vec::new();
        while let Some(row) = rows.next()? {
            calls.push(MissingReturn {
                run: crate::sql::identity(row.get(0)?)?,
                key: ExternalEffectKey {
                    task: crate::sql::identity(row.get(1)?)?,
                    operation: crate::sql::identity(row.get(2)?)?,
                },
                cell: crate::sql::identity(row.get(3)?)?,
            });
        }
        Ok(calls)
    }
}

pub(crate) enum PersistedExternalEffect {
    Prepared {
        extra_refs: Vec<ContentRef>,
    },
    Returned {
        returned: Box<maka_agent_facts::external_effects::StoredExternalReturn>,
    },
    Other,
}

pub(crate) struct ReadDescriptor(pub RunId, pub ExternalEffectKey);
impl maka_event_log::connection::Query for ReadDescriptor {
    type Output = ExternalEffectDescriptor;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let original = read_original(c, self.0, &self.1)?;
        read_descriptor(c, self.0, &self.1, &original.descriptor)
    }
}

pub(crate) struct ReadReturn(pub RunId, pub ContentRef);
impl maka_event_log::connection::Query for ReadReturn {
    type Output = maka_agent_facts::external_effects::ExternalReturn;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let bytes = crate::sql::owned_content(c, self.0, &self.1)?;
        let stored: maka_agent_facts::external_effects::StoredExternalReturn =
            serde_json::from_slice(&bytes)?;
        let cell_observation = match stored.completed_cell_result() {
            Some(result_ref) => Some(crate::sql::owned_content(c, self.0, result_ref)?),
            None => None,
        };
        stored.resolve(cell_observation.as_deref()).map_err(invalid)
    }
}

pub(crate) struct ReadEffect(pub RunId, pub ExternalEffectKey);
impl maka_event_log::connection::Query for ReadEffect {
    type Output = Option<ExternalEffect>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        Ok(read(c, self.0, &self.1)?.map(|(_, effect)| effect))
    }
}

pub(crate) fn read_original(
    c: &Connection,
    run: RunId,
    key: &ExternalEffectKey,
) -> Result<ExternalEffect, StoreError> {
    read(c, run, key)?
        .map(|(_, effect)| effect)
        .ok_or_else(|| invalid("external Host effect has not been prepared"))
}

fn read(
    c: &Connection,
    run: RunId,
    key: &ExternalEffectKey,
) -> Result<Option<(u64, ExternalEffect)>, StoreError> {
    let raw: Option<(String, i64, String)> = c
        .prepare_cached(
            "SELECT task,revision,body FROM agent_external_effects WHERE run=? AND operation=?",
        )?
        .query_row(params![run.to_string(), key.operation.to_string()], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .optional()?;
    raw.map(|(task, revision, body)| {
        if task != key.task.to_string() {
            return Err(invalid("external Host effect belongs to another task"));
        }
        Ok((
            u64::try_from(revision).map_err(|_| invalid("negative external effect revision"))?,
            serde_json::from_str(&body)?,
        ))
    })
    .transpose()
}

pub(crate) fn read_stored_descriptor(
    c: &Connection,
    run: RunId,
    reference: &ContentRef,
) -> Result<StoredExternalEffectDescriptor, StoreError> {
    let bytes = crate::sql::owned_content(c, run, reference)?;
    Ok(serde_json::from_slice(&bytes)?)
}

fn validate_and_resolve_descriptor(
    c: &Connection,
    run: RunId,
    key: &ExternalEffectKey,
    stored: StoredExternalEffectDescriptor,
) -> Result<ExternalEffectDescriptor, StoreError> {
    let descriptor = stored.resolve(|definition_ref| {
        let bytes = crate::sql::owned_content(c, run, definition_ref)?;
        Ok::<_, StoreError>(serde_json::from_slice(&bytes)?)
    })?;
    let session: String = c.query_row(
        "SELECT session FROM agent_run_specs WHERE run=?",
        [run.to_string()],
        |r| r.get(0),
    )?;
    if descriptor.schema_version != SCHEMA_VERSION
        || descriptor.execution.run_id != run
        || descriptor.execution.session_id != session
        || descriptor.key != *key
        || !matches!(&descriptor.origin, maka_agent_facts::tool_call::ToolOrigin::External { task,operation,.. } if *task==key.task && *operation==key.operation)
        || key.operation.is_nil()
        || descriptor.protocol.is_empty()
        || descriptor.operation_id != format!("external:{}:{}", key.task, key.operation)
        || descriptor.name.is_empty()
        || descriptor.name != descriptor.definition.name
        || !maka_agent_facts::archive::valid_projection_digest(&descriptor.catalog_digest)
    {
        return Err(invalid(
            "external Host descriptor differs from the original call identity",
        ));
    }
    let source = read_task_source(c, run, key)?;
    if !matches!(&descriptor.origin,maka_agent_facts::tool_call::ToolOrigin::External{package_id,entry_id,activation,..}
        if package_id==&source.package_id && entry_id==&source.entry_id && activation==&source.activation)
    {
        return Err(invalid(
            "external Host call source differs from the original accepted executor",
        ));
    }
    for resource in &descriptor.resources {
        if let ResourceRecovery::Reference { descriptor } = resource {
            descriptor.validate().map_err(invalid)?;
        }
    }
    Ok(descriptor)
}

pub(crate) fn read_descriptor_with_definition_ref(
    c: &Connection,
    run: RunId,
    key: &ExternalEffectKey,
    reference: &ContentRef,
) -> Result<(ExternalEffectDescriptor, Option<ContentRef>), StoreError> {
    let stored = read_stored_descriptor(c, run, reference)?;
    let definition_ref = stored.definition.content_ref().cloned();
    let descriptor = validate_and_resolve_descriptor(c, run, key, stored)?;
    Ok((descriptor, definition_ref))
}

pub(crate) fn read_descriptor(
    c: &Connection,
    run: RunId,
    key: &ExternalEffectKey,
    reference: &ContentRef,
) -> Result<ExternalEffectDescriptor, StoreError> {
    read_descriptor_with_definition_ref(c, run, key, reference).map(|(descriptor, _)| descriptor)
}

pub(crate) fn load_run(
    c: &Connection,
    run: RunId,
    targets: &[&Fact],
    all: bool,
) -> Result<BTreeMap<Uuid, ExternalEffect>, StoreError> {
    let keys: Vec<_> = targets
        .iter()
        .filter_map(|f| match f {
            Fact::ExternalEffect { event } => Some(event.key().operation.to_string()),
            _ => None,
        })
        .collect();
    let query = if all {
        "SELECT operation,body FROM agent_external_effects WHERE run=?1"
    } else {
        "SELECT operation,body FROM agent_external_effects WHERE run=?1 AND pending=1
         UNION ALL SELECT operation,body FROM agent_external_effects WHERE run=?1 AND pending=0
         AND operation IN (SELECT value FROM json_each(?2))"
    };
    let mut q = c.prepare_cached(query)?;
    let mut rows = if all {
        q.query([run.to_string()])?
    } else {
        q.query(params![run.to_string(), serde_json::to_string(&keys)?])?
    };
    let mut result = BTreeMap::new();
    while let Some(row) = rows.next()? {
        let operation =
            Uuid::parse_str(&row.get::<_, String>(0)?).map_err(|e| invalid(e.to_string()))?;
        let effect = serde_json::from_str(&row.get::<_, String>(1)?)?;
        result.insert(operation, effect);
    }
    Ok(result)
}

/// The caller has appended the canonical fact and retained its content under the
/// same guarded Root transaction. This is not an independent mutation entrance.
pub(crate) fn persist(
    c: &Connection,
    run: RunId,
    revision: u64,
    event: &ExternalEffectEvent,
) -> Result<PersistedExternalEffect, StoreError> {
    let key = event.key();
    let persisted = match event {
        ExternalEffectEvent::Prepared { descriptor, .. } => {
            let stored = read_stored_descriptor(c, run, descriptor)?;
            let definition_ref = stored.definition.content_ref().cloned();
            if let Some(ref definition_ref) = definition_ref {
                crate::sql::pin(c, run, definition_ref)?;
            }
            let original = validate_and_resolve_descriptor(c, run, &key, stored)?;
            let mut extra_refs = Vec::new();
            extra_refs.extend(definition_ref);
            for resource in original.resources {
                if let ResourceRecovery::Reference { descriptor } = resource {
                    crate::sql::pin(c, run, &descriptor)?;
                    extra_refs.push(descriptor);
                }
            }
            PersistedExternalEffect::Prepared { extra_refs }
        }
        ExternalEffectEvent::Admitted {
            approval: Some(approval),
            ..
        } => {
            let original = read_original(c, run, &key)?;
            if original.admitted {
                return Err(invalid("external Host approval was already consumed"));
            }
            crate::interactions::consume_external_approval(
                c,
                run,
                &key,
                *approval,
                &original.descriptor,
            )?;
            PersistedExternalEffect::Other
        }
        ExternalEffectEvent::Returned { output, .. } => {
            let original = read_original(c, run, &key)?;
            let returned: maka_agent_facts::external_effects::StoredExternalReturn =
                serde_json::from_slice(&crate::sql::owned_content(c, run, output)?)?;
            if let Some(result_ref) = returned.completed_cell_result() {
                crate::sql::pin(c, run, result_ref)?;
            }
            if let maka_agent_facts::external_effects::StoredExternalReturn::Failure {
                settlement,
                ..
            } = &returned
                && !matches!(
                    settlement,
                    maka_agent_facts::tool_call::ToolSettlement::Failed
                        | maka_agent_facts::tool_call::ToolSettlement::Rejected
                )
            {
                return Err(invalid(
                    "external failure requires a definite failed or rejected settlement",
                ));
            }
            match (&original.reference, &returned) {
                (
                    Some(reference),
                    maka_agent_facts::external_effects::StoredExternalReturn::Output {
                        output: ToolOutput::Operation(reply),
                        ..
                    },
                ) if reference == &reply.reference
                    && original.observation.as_ref() == Some(reply.as_ref()) => {}
                (Some(_), _) => {
                    return Err(invalid(
                        "external Host return is not the original full operation reply",
                    ));
                }
                (
                    None,
                    maka_agent_facts::external_effects::StoredExternalReturn::Output {
                        output: ToolOutput::Operation(_),
                        ..
                    },
                ) => {
                    return Err(invalid(
                        "external operation return has no original bound reference",
                    ));
                }
                (None, _) => {}
            }
            PersistedExternalEffect::Returned {
                returned: Box::new(returned),
            }
        }
        _ => PersistedExternalEffect::Other,
    };
    replay(c, run, revision, event)?;
    if let ExternalEffectEvent::Bound { reference, .. } = event {
        let pin = format!("external:{}:{}", key.task, key.operation);
        c.execute("INSERT INTO agent_operation_pins(run,tool,reference_json) VALUES(?,?,?) ON CONFLICT DO NOTHING", params![run.to_string(),pin,serde_json::to_string(reference)?])?;
    }
    Ok(persisted)
}

pub(crate) fn replay(
    c: &Connection,
    run: RunId,
    revision: u64,
    event: &ExternalEffectEvent,
) -> Result<(), StoreError> {
    let key = event.key();
    let previous = read(c, run, &key)?;
    if previous.as_ref().is_some_and(|(old, _)| *old >= revision) {
        return Err(invalid(
            "external Host projection revision is not increasing",
        ));
    }
    let mut effects = BTreeMap::new();
    if let Some((_, effect)) = previous {
        effects.insert(key.operation, effect);
    }
    fold(&mut effects, event)?;
    let effect = effects.get(&key.operation).expect("folded effect");
    c.execute(
        "INSERT INTO agent_external_effects(run,operation,task,revision,pending,body) VALUES(?,?,?,?,?,?)
         ON CONFLICT(run,operation) DO UPDATE SET revision=excluded.revision,pending=excluded.pending,body=excluded.body",
        params![run.to_string(),key.operation.to_string(),key.task.to_string(),signed(revision)?,effect.pending(),serde_json::to_string(effect)?],
    )?;
    Ok(())
}

fn signed(value: u64) -> Result<i64, StoreError> {
    i64::try_from(value).map_err(|_| invalid("external effect integer exceeds SQLite range"))
}

pub(crate) fn native_source_pending(
    c: &Connection,
    execution: &ExecutionIdentity,
    key: &ExternalEffectKey,
    reference: &RecoveryRef,
) -> Result<bool, StoreError> {
    let (version,bytes,task,stopped,terminal):(u32,Vec<u8>,Option<String>,bool,Option<String>)=c.query_row(
        "SELECT s.schema_version,maka_content_bytes(c.payload,c.encoding),r.external,r.stopped,r.terminal FROM agent_run_specs s JOIN contents c ON c.id=s.spec_content_id JOIN agent_runs r ON r.run=s.run WHERE s.run=?",
        [execution.run_id.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))
    )?;
    let spec: RunSpec = serde_json::from_slice(&bytes)?;
    if version != SCHEMA_VERSION
        || spec.schema_version != version
        || spec.session_id != execution.session_id
        || spec.turn_id != execution.turn_id
        || !matches!(spec.origin, RunOrigin::Local)
        || !matches!(spec.backend, BackendSpec::Executor { .. })
    {
        return Err(invalid(
            "external native source does not belong to the original local executor Run",
        ));
    }
    let task: crate::fold::ExternalTask = serde_json::from_str(
        &task.ok_or_else(|| invalid("external native source has no original task"))?,
    )?;
    if task.task != key.task || !task.admitted {
        return Err(invalid(
            "external native source does not belong to an admitted task",
        ));
    }
    let effect = read_original(c, execution.run_id, key)?;
    let descriptor = read_descriptor(c, execution.run_id, key, &effect.descriptor)?;
    if descriptor.execution != *execution
        || !effect.admitted
        || effect.reference.as_ref() != Some(reference)
    {
        return Err(invalid(
            "external native source differs from the bound original Host call",
        ));
    }
    reference.validate().map_err(|e| invalid(e.to_string()))?;
    Ok(!stopped
        && terminal.is_none()
        && task.closed.is_none()
        && !effect.known()
        && !effect.ended_unknown())
}

pub(crate) fn verify_native_source(
    c: &Connection,
    execution: &ExecutionIdentity,
    key: &ExternalEffectKey,
    reference: &RecoveryRef,
) -> Result<String, StoreError> {
    if !native_source_pending(c, execution, key, reference)? {
        return Err(invalid(
            "external native source is no longer an active original operation",
        ));
    }
    Ok(format!("external:{}:{}", key.task, key.operation))
}

fn read_task_source(
    c: &Connection,
    run: RunId,
    key: &ExternalEffectKey,
) -> Result<maka_agent_facts::executor::Binding, StoreError> {
    let (task,spec_bytes):(Option<String>,Vec<u8>)=c.query_row(
        "SELECT r.external,maka_content_bytes(c.payload,c.encoding) FROM agent_runs r JOIN agent_run_specs s ON s.run=r.run JOIN contents c ON c.id=s.spec_content_id WHERE r.run=?",
        [run.to_string()],|r|Ok((r.get(0)?,r.get(1)?))
    )?;
    let task: crate::fold::ExternalTask = serde_json::from_str(
        &task.ok_or_else(|| invalid("external source has no original task"))?,
    )?;
    if task.task != key.task || !task.admitted {
        return Err(invalid("external source has no original admitted task"));
    }
    let spec: RunSpec = serde_json::from_slice(&spec_bytes)?;
    let BackendSpec::Executor { selection, .. } = spec.backend else {
        return Err(invalid("external task source belongs to a model Run"));
    };
    let original: maka_agent_facts::executor::TaskDescriptor<serde::de::IgnoredAny> =
        serde_json::from_slice(&crate::sql::owned_content(c, run, &task.descriptor)?)?;
    original.source.validate().map_err(invalid)?;
    if original.protocol != NATIVE_TASK_PROTOCOL
        || original.source.executor_id.as_str() != selection.executor
    {
        return Err(invalid(
            "external task descriptor differs from the accepted executor protocol",
        ));
    }
    if let Some(binding) = &task.binding {
        let bound: maka_agent_facts::executor::TaskDescriptor<serde::de::IgnoredAny> =
            serde_json::from_slice(&crate::sql::owned_content(c, run, binding)?)?;
        if bound.protocol != original.protocol || bound.source != original.source {
            return Err(invalid(
                "external task binding changed its original accepted source",
            ));
        }
    }
    Ok(original.source)
}

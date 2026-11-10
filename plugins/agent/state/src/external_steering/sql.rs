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
use maka_agent_facts::input::MessageInput;
use rusqlite::{Connection, OptionalExtension, params};

fn content_id(c: &Connection, reference: &ContentRef) -> Result<i64, StoreError> {
    reference.validate().map_err(invalid)?;
    Ok(c.query_row(
        "SELECT id FROM contents WHERE content_sha256=? AND length(payload)=?",
        params![
            reference.digest,
            i64::try_from(reference.bytes)
                .map_err(|_| invalid("steering content exceeds SQLite range"))?
        ],
        |r| r.get(0),
    )?)
}

pub(crate) fn read_spec(
    c: &Connection,
    run: RunId,
    key: &ExternalSteeringKey,
    descriptor: &ContentRef,
) -> Result<ExternalSteeringSpec, StoreError> {
    let spec: ExternalSteeringSpec =
        serde_json::from_slice(&crate::sql::owned_content(c, run, descriptor)?)?;
    let (session,run_bytes):(String,Vec<u8>) = c.query_row(
        "SELECT s.session,c.payload FROM agent_run_specs s JOIN contents c ON c.id=s.spec_content_id WHERE s.run=?",
        [run.to_string()],
        |r| Ok((r.get(0)?,r.get(1)?)),
    )?;
    let run_spec: RunSpec = serde_json::from_slice(&run_bytes)?;
    if spec.execution.turn_id != run_spec.turn_id {
        return Err(invalid(
            "external steering belongs to another Run presentation identity",
        ));
    }
    if spec.schema_version != SCHEMA_VERSION
        || spec.execution.run_id != run
        || spec.execution.session_id != session
        || spec.consume.session != session
        || spec.key != *key
        || key.steering.is_nil()
        || spec.sources.is_empty()
        || spec.consume.requests.len() != spec.sources.len()
        || spec
            .consume
            .requests
            .iter()
            .zip(&spec.sources)
            .any(|(id, source)| id != &source.request)
    {
        return Err(invalid(
            "external steering descriptor differs from its original queue cut",
        ));
    }
    for reference in spec.content_refs() {
        content_id(c, reference)?;
    }
    let input: MessageInput = serde_json::from_slice(
        &maka_event_log::content::read(c, &spec.input.digest)?
            .ok_or_else(|| invalid("missing frozen external steering input"))?,
    )?;
    let mut source_inputs = Vec::with_capacity(spec.sources.len());
    for source in &spec.sources {
        let original: maka_agent_facts::message::RootSourceMessage = serde_json::from_slice(
            &maka_event_log::content::read(c, &source.source.digest)?
                .ok_or_else(|| invalid("missing original steering source"))?,
        )?;
        original.validate().map_err(invalid)?;
        source_inputs.push(attributed_source(original, run_spec.language));
    }
    if input != maka_agent_facts::message::aggregate(source_inputs.iter()) {
        return Err(invalid(
            "external steering delivery differs from its ordered attributed sources",
        ));
    }
    Ok(spec)
}

pub(crate) fn read_original(
    c: &Connection,
    run: RunId,
    key: &ExternalSteeringKey,
) -> Result<ExternalSteering, StoreError> {
    let raw:Option<(String,String,i64,bool)>=c.query_row(
        "SELECT e.task,c.content_sha256,length(c.payload),e.admitted_fact IS NOT NULL FROM agent_external_steering e JOIN contents c ON c.id=e.descriptor_content_id WHERE e.run=? AND e.steering=?",
        params![run.to_string(),key.steering.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))
    ).optional()?;
    let (task, digest, bytes, admitted) =
        raw.ok_or_else(|| invalid("external steering was not prepared"))?;
    if task != key.task.to_string() {
        return Err(invalid("external steering belongs to another task"));
    }
    Ok(ExternalSteering {
        key: *key,
        descriptor: ContentRef {
            digest,
            bytes: u64::try_from(bytes).map_err(|_| invalid("negative steering content size"))?,
        },
        admitted,
    })
}

pub(crate) fn persist(
    c: &Connection,
    run: RunId,
    recorded: &RecordedFact,
) -> Result<(), StoreError> {
    if run != recorded.run {
        return Err(invalid("external steering fact belongs to another Run"));
    }
    let Fact::ExternalSteering { event } = &recorded.fact else {
        return Err(invalid("not an external steering fact"));
    };
    let key = event.key();
    match event {
        ExternalSteeringEvent::Prepared { descriptor, .. } => {
            let spec = read_spec(c, run, &key, descriptor)?;
            for reference in spec.content_refs() {
                c.execute("INSERT INTO agent_content_pins(run,content_id) VALUES(?,?) ON CONFLICT DO NOTHING",params![run.to_string(),content_id(c,reference)?])?;
            }
        }
        ExternalSteeringEvent::Admitted { .. } => {
            let original = read_original(c, run, &key)?;
            if original.admitted {
                return Err(invalid("external steering was already adopted"));
            }
            let spec = read_spec(c, run, &key, &original.descriptor)?;
            crate::queue::consume_external_steering(
                c,
                &spec.consume,
                run,
                key.task,
                key.steering,
                &original.descriptor,
                recorded.id,
                recorded.at,
            )?;
        }
    }
    replay(c, run, recorded)
}

/// Historical adoption never consumes the queue again or claims a provider ACK.
pub(crate) fn replay(
    c: &Connection,
    run: RunId,
    recorded: &RecordedFact,
) -> Result<(), StoreError> {
    if recorded.run != run || recorded.schema_version != SCHEMA_VERSION {
        return Err(invalid("external steering canonical identity mismatch"));
    }
    let Fact::ExternalSteering { event } = &recorded.fact else {
        return Err(invalid("not an external steering fact"));
    };
    let key = event.key();
    match event {
        ExternalSteeringEvent::Prepared { descriptor, .. } => {
            c.execute("INSERT INTO agent_external_steering(run,steering,task,descriptor_content_id,prepared_fact,admitted_fact) VALUES(?,?,?,?,?,NULL)",params![run.to_string(),key.steering.to_string(),key.task.to_string(),content_id(c,descriptor)?,recorded.id.to_string()])?;
        }
        ExternalSteeringEvent::Admitted { .. } => {
            let changed=c.execute("UPDATE agent_external_steering SET admitted_fact=? WHERE run=? AND steering=? AND task=? AND admitted_fact IS NULL",params![recorded.id.to_string(),run.to_string(),key.steering.to_string(),key.task.to_string()])?;
            if changed != 1 {
                return Err(invalid(
                    "external steering has no unconsumed original preparation",
                ));
            }
        }
    }
    Ok(())
}

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
use maka_agent_facts::{
    attachment::{AttachmentRef, StorageRef},
    external_steering::ExternalSteeringEvent,
    input::RunInput,
    message::RootSourceMessage,
};
use rusqlite::{Connection, params};
use std::collections::BTreeSet;

fn material(
    c: &Connection,
    owner: &RunOwner,
    session: &str,
    attachment: &AttachmentRef,
) -> Result<Option<read::Material>, StoreError> {
    let StorageRef::SessionFile {
        session_id,
        relative_path,
    } = &attachment.storage_ref
    else {
        // Non-artifact resource descriptors belong to native reacquisition;
        // this store neither reads filesystem paths nor grants their use.
        return Ok(None);
    };
    if session_id != session {
        return Err(invalid(
            "input attachment requires an explicitly authorized session copy",
        ));
    }
    let scope = SessionScope {
        owner: owner.clone(),
        session: session.into(),
    };
    let material = read::lookup(c, &scope.into(), relative_path)?
        .ok_or_else(|| invalid("input attachment has no canonical session registration"))?;
    material
        .record
        .artifact
        .validate_attachment(attachment)
        .map_err(invalid)?;
    Ok(Some(material))
}
pub(crate) fn pin_request(
    c: &Connection,
    request: &crate::queue::PreparedRequest,
    source: &RootSourceMessage,
) -> Result<(), StoreError> {
    let mut ids = BTreeSet::new();
    for attachment in source
        .message
        .content
        .attachments
        .iter()
        .flatten()
        .chain(source.unprepared_content.attachments.iter().flatten())
    {
        let Some(material) =
            material(c, &request.spec.owner, &request.spec.session_id, attachment)?
        else {
            continue;
        };
        if !ids.insert(material.record.artifact.id) {
            continue;
        }
        c.execute("INSERT OR IGNORE INTO agent_queue_content_pins(session,request,content_id) VALUES(?,?,?)",params![request.spec.session_id,request.id.0,material.rowid])?;
    }
    Ok(())
}
fn bind_attachments<'a>(
    c: &Connection,
    run: RunId,
    spec: &RunSpec,
    evidence: tool::BindingEvidence<'_>,
    attachments: impl IntoIterator<Item = &'a AttachmentRef>,
) -> Result<(), StoreError> {
    let mut ids = BTreeSet::new();
    for attachment in attachments {
        let Some(material) = material(c, &spec.owner, &spec.session_id, attachment)? else {
            continue;
        };
        if !ids.insert(material.record.artifact.id.clone()) {
            continue;
        }
        tool::bind(c, run, spec, &material.record, evidence)?;
    }
    Ok(())
}
pub(crate) fn admit(
    c: &Connection,
    run: RunId,
    spec: &RunSpec,
    fact: FactId,
) -> Result<(), StoreError> {
    let input: RunInput = tool::owned_decode(c, run, &spec.input)?;
    if let RunInput::Message {
        content,
        source_messages,
        ..
    } = input
    {
        bind_attachments(
            c,
            run,
            spec,
            tool::BindingEvidence {
                fact,
                revision: 1,
                source: &spec.input,
                origin: &tool::BindingOrigin::Input,
            },
            content.attachments.iter().flatten().chain(
                source_messages
                    .iter()
                    .flat_map(|source| source.message.content.attachments.iter().flatten()),
            ),
        )?;
    }
    Ok(())
}
pub(super) fn step(c: &Connection, run: RunId, recorded: &RecordedFact) -> Result<(), StoreError> {
    let Fact::StepPrepared { request, .. } = &recorded.fact else {
        return Ok(());
    };
    let request: RequestSpec = tool::owned_decode(c, run, request)?;
    if request.steering.is_empty() {
        return Ok(());
    }
    pin_steering_sources(
        c,
        run,
        recorded.id,
        recorded.revision,
        request.steering.iter(),
    )
}
pub(super) fn external(
    c: &Connection,
    run: RunId,
    recorded: &RecordedFact,
) -> Result<(), StoreError> {
    let Fact::ExternalSteering {
        event: ExternalSteeringEvent::Admitted { key },
    } = &recorded.fact
    else {
        return Ok(());
    };
    let original = crate::external_steering::read_original(c, run, key)?;
    let frozen = crate::external_steering::read_spec(c, run, key, &original.descriptor)?;
    pin_steering_sources(
        c,
        run,
        recorded.id,
        recorded.revision,
        frozen.sources.iter().map(|source| &source.source),
    )
}
fn pin_steering_sources<'a>(
    c: &Connection,
    run: RunId,
    fact: FactId,
    revision: u64,
    sources: impl IntoIterator<Item = &'a ContentRef>,
) -> Result<(), StoreError> {
    let spec = tool::run_spec(c, run)?;
    for reference in sources {
        let source: RootSourceMessage = tool::owned_decode(c, run, reference)?;
        bind_attachments(
            c,
            run,
            &spec,
            tool::BindingEvidence {
                fact,
                revision,
                source: reference,
                origin: &tool::BindingOrigin::Steering,
            },
            source.message.content.attachments.iter().flatten(),
        )?;
    }
    Ok(())
}

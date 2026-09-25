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
    artifacts::references,
    bundle::{
        Inventory,
        format::{Blob, Record},
    },
};
use maka_runtime::{
    artifact::Artifact,
    attachment::{AttachmentRef, StorageRef},
    event::RuntimeEvent,
};
use sqlx::SqliteConnection;

pub(super) async fn validate(
    staged: &mut SqliteConnection,
    original: &mut SqliteConnection,
    inventory: &Inventory,
) -> Result<(), StoreError> {
    sqlx::query("DELETE FROM referenced_mappings")
        .execute(&mut *staged)
        .await?;
    let mut after = 0i64;
    loop {
        let row: Option<(i64, String)> = sqlx::query_as(
            "SELECT number,record_json FROM frames WHERE number>? AND
             ((kind='blob' AND json_extract(record_json,'$.resource')='artifact') OR kind='history_artifact')
             ORDER BY number LIMIT 1"
        ).bind(after).fetch_optional(&mut *staged).await?;
        let Some((number, json)) = row else { break };
        match serde_json::from_str(&json)? {
            Record::Blob(Blob::Artifact { metadata, digest }) => {
                selected(inventory, &metadata.session_id)?;
                crate::artifacts::validate_material(&metadata, metadata.size_bytes, &digest)?;
            }
            Record::HistoryArtifact {
                session,
                source_session,
                source_artifact,
                artifact,
            } => {
                selected(inventory, &session)?;
                crate::sessions::validate_id(&source_session)?;
                maka_runtime::interaction::entity_id(&source_artifact).map_err(invalid)?;
                let identity = maka_runtime::artifact::content_digest(&serde_json::to_vec(&(
                    &source_session,
                    &source_artifact,
                ))?);
                if artifact != format!("history-{}", identity.trim_start_matches("sha256:")) {
                    return Err(invalid(
                        "bundle history Artifact identity differs from its provenance",
                    ));
                }
                if descriptor(staged, &session, &artifact).await?.is_none() {
                    return Err(invalid("bundle history mapping lacks its owned Artifact"));
                }
            }
            _ => unreachable!(),
        }
        after = number;
    }
    for session in &inventory.sessions {
        let mut after = (0i64, false);
        loop {
            let row: Option<(i64, bool, bool, String)> = sqlx::query_as(
                "SELECT e.sequence,0 AS revision,e.inherited,e.event_json FROM session_history_events e
                 WHERE e.owner_session_id=?1 AND (e.sequence,0)>(?2,?3)
                 UNION ALL
                 SELECT e.sequence,1 AS revision,1 AS inherited,e.event_json FROM session_revision_sources r
                 JOIN runtime_events e ON e.sequence=r.sequence WHERE r.session_id=?1 AND (e.sequence,1)>(?2,?3)
                 ORDER BY sequence,revision LIMIT 1"
            ).bind(&session.id).bind(after.0).bind(after.1).fetch_optional(&mut *original).await?;
            let Some((sequence, revision, inherited, json)) = row else {
                break;
            };
            let event: RuntimeEvent = serde_json::from_str(&json)?;
            let refs = if revision {
                references::revision(&event)?
                    .into_iter()
                    .map(|a| (&a.storage_ref, Some(a)))
                    .collect()
            } else {
                references::from_event(&event)
            };
            for (reference, attachment) in refs {
                reference_material(staged, &session.id, inherited, reference, attachment).await?;
            }
            generated(staged, &session.id, inherited, &event).await?;
            after = (sequence, revision);
        }
    }
    let unbound: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM frames f WHERE f.kind='history_artifact'
         AND NOT EXISTS(SELECT 1 FROM referenced_mappings r WHERE r.frame=f.number))",
    )
    .fetch_one(staged)
    .await?;
    if unbound {
        return Err(invalid(
            "bundle history mapping lacks a typed copied reference",
        ));
    }
    Ok(())
}

async fn reference_material(
    staged: &mut SqliteConnection,
    owner: &str,
    inherited: bool,
    reference: &StorageRef,
    attachment: Option<&AttachmentRef>,
) -> Result<(), StoreError> {
    let StorageRef::SessionFile {
        session_id,
        relative_path,
    } = reference
    else {
        // Workspace and external files are not transferred, and Session context
        // is canonical evidence rather than an Artifact payload.
        return Ok(());
    };
    let artifact = if inherited {
        let mapping: Option<(i64, String)> = sqlx::query_as(
            "SELECT number,json_extract(record_json,'$.artifact') FROM frames WHERE kind='history_artifact'
             AND json_extract(record_json,'$.session')=? AND json_extract(record_json,'$.source_session')=?
             AND json_extract(record_json,'$.source_artifact')=?"
        ).bind(owner).bind(session_id).bind(relative_path).fetch_optional(&mut *staged).await?;
        let (frame, id) = mapping
            .ok_or_else(|| invalid("bundle copied reference lacks its retained Artifact"))?;
        sqlx::query("INSERT INTO referenced_mappings(frame) VALUES(?) ON CONFLICT DO NOTHING")
            .bind(frame)
            .execute(&mut *staged)
            .await?;
        descriptor(staged, owner, &id)
            .await?
            .ok_or_else(|| invalid("bundle history mapping lacks its owned Artifact"))?
            .0
    } else if session_id == owner {
        // Users may delete ordinary uploads while their immutable references
        // remain in history. Preserve that absence instead of inventing bytes.
        let Some((artifact, _)) = descriptor(staged, owner, relative_path).await? else {
            return Ok(());
        };
        artifact
    } else {
        return Ok(());
    };
    if let Some(attachment) = attachment {
        artifact.validate_attachment(attachment).map_err(invalid)?;
    }
    Ok(())
}

async fn descriptor(
    staged: &mut SqliteConnection,
    session: &str,
    id: &str,
) -> Result<Option<(Artifact, String)>, StoreError> {
    let row: Option<String> = sqlx::query_scalar(
        "SELECT record_json FROM frames WHERE kind='blob' AND json_extract(record_json,'$.resource')='artifact'
         AND json_extract(record_json,'$.metadata.sessionId')=? AND json_extract(record_json,'$.metadata.id')=?"
    ).bind(session).bind(id).fetch_optional(staged).await?;
    row.map(|json| {
        let Record::Blob(Blob::Artifact { metadata, digest }) = serde_json::from_str(&json)? else {
            unreachable!()
        };
        Ok((metadata, digest))
    })
    .transpose()
}

async fn generated(
    staged: &mut SqliteConnection,
    owner: &str,
    inherited: bool,
    event: &RuntimeEvent,
) -> Result<(), StoreError> {
    use maka_runtime::{
        artifact::{ArtifactKind, ArtifactSource},
        event::{Fact, ToolOutcome},
        tool_output::DurableToolProjection,
    };
    let Fact::ToolSettled {
        outcome:
            ToolOutcome::Succeeded {
                artifacts,
                model_projection,
                ..
            },
        ..
    } = &event.fact
    else {
        return Ok(());
    };
    for evidence in artifacts {
        let id = if inherited {
            sqlx::query_scalar(
                "SELECT json_extract(record_json,'$.artifact') FROM frames WHERE kind='history_artifact'
                 AND json_extract(record_json,'$.session')=? AND json_extract(record_json,'$.source_session')=?
                 AND json_extract(record_json,'$.source_artifact')=?"
            ).bind(owner).bind(&event.invocation.session_id).bind(&evidence.id)
                .fetch_optional(&mut *staged).await?
                .ok_or_else(|| invalid("bundle generated Artifact has no copied ownership"))?
        } else {
            evidence.id.clone()
        };
        let (artifact, digest) = descriptor(staged, owner, &id)
            .await?
            .ok_or_else(|| invalid("bundle lacks generated tool material"))?;
        let mime_matches = matches!(model_projection, DurableToolProjection::Content { parts } if parts.iter().any(|part|
            part.media().is_some_and(|(reference, mime)|
                matches!(reference, StorageRef::SessionFile { relative_path, .. } if relative_path == &evidence.id)
                && artifact.mime_type.as_deref() == Some(mime)
                && artifact.kind == if mime.starts_with("image/") { ArtifactKind::Image } else { ArtifactKind::File })
        ));
        if artifact.source != ArtifactSource::ToolResultProjection
            || artifact.turn_id != event.invocation.turn_id
            || artifact.size_bytes != evidence.bytes
            || digest != evidence.digest
            || !mime_matches
        {
            return Err(invalid(
                "bundle generated tool material differs from its canonical evidence",
            ));
        }
    }
    Ok(())
}

fn selected(inventory: &Inventory, id: &str) -> Result<(), StoreError> {
    if inventory
        .sessions
        .binary_search_by(|s| s.id.as_str().cmp(id))
        .is_err()
    {
        return Err(invalid("bundle Artifact is outside its selected catalog"));
    }
    Ok(())
}

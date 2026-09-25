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

use super::{Change, Failure, artifacts, source_content, workspace_id};
use crate::{
    OriginStatus, SourceCatalog,
    api::*,
    publication::{
        Publisher,
        receipt::{Destination, Operation},
    },
};
use maka_runtime::artifact::content_digest;
use tokio_util::sync::CancellationToken;

pub(super) async fn apply(
    publisher: &Publisher,
    sources: &SourceCatalog,
    update: &ManagedUpdate,
    operation: Option<&Operation>,
    cancellation: &CancellationToken,
) -> Result<Change, Failure> {
    let id = workspace_id(&update.reference)?;
    let origin = sources
        .publication
        .origins
        .get(&update.reference)
        .ok_or(Failure::Rejected(MutationRejection::NotFound))?;
    let (source_id, baseline_hash) = match &origin.status {
        OriginStatus::Managed {
            source_id,
            content_sha256,
        } => (source_id, content_sha256),
        OriginStatus::Invalid(_) => {
            return Err(Failure::Rejected(MutationRejection::MetadataError));
        }
        _ => return Err(Failure::Rejected(MutationRejection::NotManaged)),
    };
    let source = source_content(sources, source_id, cancellation)?;
    let source_hash = content_digest(&source);
    let expected = publisher
        .capture(id, cancellation)
        .await?
        .ok_or(Failure::Rejected(MutationRejection::NotFound))?;
    let current = expected
        .get("SKILL.md")
        .ok_or(Failure::Rejected(MutationRejection::MetadataError))?;
    let current_hash = content_digest(current);
    let current_basis = sources
        .publication
        .discovery
        .inventory
        .iter()
        .map(|skill| (&skill.location.reference, &skill.content_sha256))
        .chain(
            sources
                .publication
                .discovery
                .rejected
                .iter()
                .map(|skill| (&skill.location.reference, &skill.content_sha256)),
        )
        .find(|(reference, _)| *reference == &update.reference)
        .map(|(_, hash)| hash);
    if current_basis != Some(&current_hash)
        || expected.get("skill.lock.json").map(content_digest).as_ref()
            != origin.lock_sha256.as_ref()
    {
        return Err(Failure::Rejected(MutationRejection::SourceChanged));
    }
    if expected
        .get(".maka/baseline/SKILL.md")
        .map(content_digest)
        .as_ref()
        != Some(baseline_hash)
    {
        return Err(Failure::Rejected(MutationRejection::MetadataError));
    }
    match &update.confirmation {
        UpdateConfirmation::UnmodifiedOnly if current_hash != *baseline_hash => {
            return Err(Failure::Rejected(MutationRejection::LocalModified));
        }
        UpdateConfirmation::Confirmed {
            current_sha256,
            source_sha256,
        } if current_sha256 != &current_hash || source_sha256 != &source_hash => {
            return Err(Failure::Rejected(MutationRejection::SourceChanged));
        }
        _ => {}
    }
    if current_hash == source_hash && baseline_hash == &source_hash {
        return Ok(Change {
            changed: false,
            reference: Some(update.reference.clone()),
        });
    }
    let mut next = expected.clone();
    artifacts(&mut next, id, source_id, InstallSource::Managed, source)?;
    publisher
        .publish_operation(
            id,
            Some(&expected),
            Some(&next),
            operation.map(|operation| {
                (
                    operation,
                    Destination::Skill {
                        reference: update.reference.clone(),
                    },
                )
            }),
            cancellation,
        )
        .await?;
    Ok(Change {
        changed: true,
        reference: Some(update.reference.clone()),
    })
}

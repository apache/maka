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

//! Operation receipts are independent of the current catalog or filesystem generation.
use super::{Error, Skills};
use crate::{
    api::*,
    publication::{
        self,
        receipt::{Destination, Operation, Outcome, Record},
    },
};
use maka_plugins::filesystem::{
    ReadDirectory,
    entries::{self, ReadFile},
};
use maka_runtime::execution::WorkspaceProjection;

mod import;
mod review;

impl Skills {
    /// Reads only the immutable outcome. It does not recover, publish, or retry.
    pub(super) async fn outcome(
        &self,
        id: uuid::Uuid,
        binding: &str,
    ) -> Result<Option<Record>, Error> {
        let page = match self
            .data
            .read(ReadFile {
                path: format!("receipts/{id}.json"),
                offset: 0,
                limit: 16 * 1024,
            })
            .await
        {
            Ok(page) if page.next_offset.is_none() => page,
            Ok(_) => return Err(Error::Invalid("Skill receipt exceeds limit".into())),
            Err(entries::Error::NotFound) => return Ok(None),
            Err(error) => return Err(Error::Source(error.to_string())),
        };
        let record: Record = serde_json::from_slice(&page.bytes)?;
        if record.operation.id != id || record.operation.binding != binding {
            return Err(Error::Invalid(
                "Skill receipt belongs to another request".into(),
            ));
        }
        Ok(Some(record))
    }

    pub(super) async fn mutate_operation(
        &self,
        input: MutateInput,
        workspace: WorkspaceProjection,
        workspace_files: ReadDirectory,
        operation: Operation,
        reviewed: Option<String>,
        source_page: Option<CatalogInput>,
    ) -> Result<Outcome, Error> {
        if matches!(
            input.mutation,
            Mutation::SetEnabled { .. }
                | Mutation::SetPinned { .. }
                | Mutation::SetPreferences { .. }
        ) {
            return Err(Error::Invalid(
                "Preferences do not declare file publication recovery".into(),
            ));
        }
        let admitted = self.basis.owner.admit().map_err(|_| Error::Retired)?;
        let skills = self.clone();
        let receiver = self
            .basis
            .owner
            .spawn_resource("Skills recorded mutation", move |_| async move {
                let _admitted = admitted;
                let _serial = skills.mutations.write().await;
                let _invalidation = skills.input_revision.invalidate().await;
                let _notice = skills.notify_on_exit();
                let result = async {
                    // Reject a reused identity before recovering any accepted effect.
                    let publisher = skills.private_publisher().await?;
                    if let Some(outcome) = publisher
                        .reserve(&operation)
                        .await
                        .map_err(publication_error)?
                    {
                        return Ok(outcome);
                    }
                    drop(publisher);
                    // Opening the current grant is required even for a remembered request.
                    if let Some(grant) = input.grant {
                        skills
                            .user_files(grant)
                            .await?
                            .finish()
                            .await
                            .map_err(publication_error)?;
                    }
                    let publisher = skills.private_publisher().await?;
                    publisher.recover().await.map_err(publication_error)?;
                    if let Some(outcome) = publisher
                        .reserve(&operation)
                        .await
                        .map_err(publication_error)?
                    {
                        return Ok(outcome);
                    }
                    drop(publisher);
                    // An explicit retry settles its original intent before a new
                    // request is compared with today's source-page revision.
                    if let Some(page) = source_page {
                        let found = skills
                            .query_inner(&page, workspace.clone(), workspace_files.clone())
                            .await?;
                        let current = match found {
                            CatalogResult::Page {
                                revision, items, ..
                            } if revision == input.expected_revision => Some(items),
                            _ => None,
                        };
                        let Some(items) = current else {
                            let publisher = skills.private_publisher().await?;
                            publisher
                                .complete(&operation, Outcome::Conflict)
                                .await
                                .map_err(publication_error)?;
                            return Ok(Outcome::Conflict);
                        };
                        let Mutation::Install {
                            source_type,
                            source_id,
                        } = &input.mutation
                        else {
                            return Err(Error::Invalid("Unexpected Skill source page".into()));
                        };
                        if !items.iter().any(|item| match (source_type, item) {
                            (InstallSource::Bundled, CatalogItem::Bundled { id, .. })
                            | (InstallSource::Managed, CatalogItem::ManagedSource { id, .. }) => {
                                id == source_id
                            }
                            _ => false,
                        }) {
                            return Err(Error::Invalid(
                                "Skill source is not on the reviewed page".into(),
                            ));
                        }
                    }
                    let result = skills
                        .mutate_inner(
                            &input,
                            workspace,
                            workspace_files,
                            Some(&operation),
                            reviewed.as_deref(),
                        )
                        .await?;
                    // A published intent retained the original identity before the catalog read.
                    let publisher = skills.private_publisher().await?;
                    if let Some(outcome) = publisher
                        .reserve(&operation)
                        .await
                        .map_err(publication_error)?
                    {
                        return Ok(outcome);
                    }
                    let outcome = match result.outcome {
                        MutationOutcome::Committed { entry, .. }
                        | MutationOutcome::Unchanged { entry, .. } => Outcome::Applied {
                            destination: match entry {
                                Some(MutationEntry::Skill(item)) => Destination::Skill {
                                    reference: item.reference,
                                },
                                None => Destination::Installed,
                            },
                        },
                        MutationOutcome::RevisionConflict { .. } => Outcome::Conflict,
                        MutationOutcome::Rejected { reason } => Outcome::Rejected {
                            reason: serde_json::to_value(reason)?.as_str().unwrap().into(),
                        },
                    };
                    publisher
                        .complete(&operation, outcome.clone())
                        .await
                        .map_err(publication_error)?;
                    Ok(outcome)
                }
                .await;
                Ok(result)
            })
            .map_err(|_| Error::Retired)?;
        receiver
            .await
            .map_err(|error| Error::OutcomeUnknown(error.to_string()))?
            .map_err(Error::OutcomeUnknown)?
    }
}
pub(super) fn publication_error(error: publication::Error) -> Error {
    match error {
        publication::Error::OutcomeUnknown(message) => Error::OutcomeUnknown(message),
        publication::Error::Cancelled => Error::Retired,
        publication::Error::Invalid(message) => Error::Invalid(message),
        other => Error::Source(other.to_string()),
    }
}

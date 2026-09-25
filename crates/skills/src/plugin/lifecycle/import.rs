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

impl Skills {
    pub(in crate::plugin) async fn import_operation(
        &self,
        input: ImportSourceInput,
        source: futures_util::future::BoxFuture<'static, Result<ReadDirectory, Error>>,
        operation: Operation,
    ) -> Result<Outcome, Error> {
        let admitted = self.basis.owner.admit().map_err(|_| Error::Retired)?;
        let skills = self.clone();
        let receiver = self
            .basis
            .owner
            .spawn_resource("Skills recorded import", move |_| async move {
                let _admitted = admitted;
                let _serial = skills.mutations.write().await;
                let _invalidation = skills.input_revision.invalidate().await;
                let _notice = skills.notify_on_exit();
                let result = async {
                    let publisher = skills.private_publisher().await?;
                    if let Some(outcome) = publisher
                        .reserve(&operation)
                        .await
                        .map_err(publication_error)?
                    {
                        return Ok(outcome);
                    }
                    drop(publisher);
                    let user = skills.user_files(input.grant).await?;
                    let result = async {
                        let publisher = user
                            .open(
                                publication::UserStore::ManagedSources,
                                skills.private_publisher().await?,
                                true,
                            )
                            .await
                            .map_err(publication_error)?
                            .ok_or_else(|| {
                                Error::Source("Managed Skills store is unavailable".into())
                            })?;
                        if let Some(outcome) = publisher
                            .reserve(&operation)
                            .await
                            .map_err(publication_error)?
                        {
                            return Ok(outcome);
                        }
                        // A retained intent owns its bytes. Only fresh work needs
                        // the original foreground source capability again.
                        let source = source.await?;
                        let cancellation =
                            skills.basis.owner.stopping().map_err(|_| Error::Retired)?;
                        let result =
                            match crate::plugin::import::read_source(&input.source_path, &source)
                                .await
                            {
                                Ok(bytes) => {
                                    crate::plugin::import::import(
                                        publisher,
                                        std::path::Path::new(&input.source_path),
                                        bytes,
                                        Some(&operation),
                                        &cancellation,
                                    )
                                    .await?
                                }
                                Err(reason) => {
                                    drop(publisher);
                                    ImportSourceResult::Rejected { reason }
                                }
                            };
                        let publisher = skills.private_publisher().await?;
                        if let Some(outcome) = publisher
                            .reserve(&operation)
                            .await
                            .map_err(publication_error)?
                        {
                            return Ok(outcome);
                        }
                        let outcome = match result {
                            ImportSourceResult::Imported { source } => Outcome::Applied {
                                destination: Destination::Source { id: source.id },
                            },
                            ImportSourceResult::Rejected { reason } => Outcome::Rejected {
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
                    let settled = user
                        .finish()
                        .await
                        .map_err(|error| Error::OutcomeUnknown(error.to_string()));
                    *skills.user_recovery.lock().unwrap() =
                        result.as_ref().err().map(ToString::to_string);
                    settled?;
                    result
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

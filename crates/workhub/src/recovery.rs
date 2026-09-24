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

use crate::{Error, assignment::Assignment, repository::Pending};
use serde::Serialize;

#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub pending_results: bool,
    pub failures: Vec<Failure>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable: Option<String>,
}
impl Report {
    pub fn retrying(&self) -> bool {
        self.unavailable.is_some() || self.failures.iter().any(|failure| failure.retrying)
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub operation_id: String,
    pub message: String,
    pub retrying: bool,
}
impl crate::plugin::Manager {
    /// Replays frozen decisions, never repeats candidate selection. Revoked consent
    /// pauses the decision; explicitly remembering a new grant may wake it again.
    pub(super) async fn recover_decisions(&self) -> Result<Report, Error> {
        let mut report = Report::default();
        for work in self.assignments.repository.pending().await? {
            let (id, result) = match work {
                Pending::Decision(id) => {
                    let result = self.execute_decision(&id, None).await.map(|_| ());
                    (id, result)
                }
                Pending::Route(id) => {
                    let key = crate::assignment::key(&id)?;
                    let assignment = self
                        .assignments
                        .repository
                        .read::<Assignment>(&key)
                        .await?
                        .ok_or(Error::Conflict)?
                        .1;
                    let result = async {
                        if assignment.delivery.is_none() {
                            self.assignments.route(assignment.request).await?;
                        }
                        report.pending_results |= self.assignments.return_result(&id).await?;
                        Ok(())
                    }
                    .await;
                    (id, result)
                }
                Pending::Control(id) => {
                    let key = crate::control::key(&id)?;
                    let request = self
                        .assignments
                        .repository
                        .read::<crate::control::Record>(&key)
                        .await?
                        .ok_or(Error::Conflict)?
                        .1
                        .request;
                    (id, self.assignments.control(request).await.map(|_| ()))
                }
            };
            if let Err(error) = result {
                let retrying = matches!(
                    &error,
                    Error::Contended
                        | Error::Storage(
                            maka_plugins::storage::StoreError::Unavailable(_)
                                | maka_plugins::storage::StoreError::OutcomeUnknown(_)
                                | maka_plugins::storage::StoreError::Conflict { .. }
                        )
                        | Error::Execution(
                            maka_plugins::execution::CommandError::Busy
                                | maka_plugins::execution::CommandError::OutcomeUnknown(_)
                                | maka_plugins::execution::CommandError::Draining
                                | maka_plugins::execution::CommandError::Unavailable(_)
                        )
                );
                report.failures.push(Failure {
                    operation_id: id,
                    message: error.to_string().chars().take(512).collect(),
                    retrying,
                });
            }
        }
        Ok(report)
    }
}

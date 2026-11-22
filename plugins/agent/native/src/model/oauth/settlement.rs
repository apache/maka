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
use maka_agent_facts::provider::Credential as Envelope;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub(super) struct State {
    pub credential: ProviderCredential,
    pub outcome: Outcome,
}

pub(super) enum Outcome {
    Ready,
    /// Keep a spent replacement on SQL failure. Retry persistence, not exchange.
    Replacement(Envelope),
    Failed(String),
}

impl State {
    pub async fn resolve(
        &mut self,
        provider: RefreshProvider,
        connection: Connection,
        context: Context,
        shutdown: &CancellationToken,
        superseded: &CancellationToken,
    ) -> Result<ProviderCredential, ModelError> {
        if let Outcome::Failed(message) = &self.outcome {
            return Err(failure(message));
        }
        if matches!(self.outcome, Outcome::Replacement(_)) {
            self.settle().await?;
        }
        let current = self
            .credential
            .current_generation()
            .await
            .map_err(|error| {
                diagnostics::configuration(
                    "credential_generation_observation",
                    &error,
                    Some(&self.credential.target().connection_id),
                );
                failure(error)
            })?
            .ok_or_else(|| failure("Provider credential was superseded"))?;
        if current.basis() != self.credential.basis() {
            return Err(failure("Provider credential was superseded"));
        }
        let now = now()?;
        if self
            .credential
            .credential()
            .refresh_at
            .is_none_or(|at| at > now)
        {
            return Ok(self.credential.clone());
        }
        if shutdown.is_cancelled() || superseded.is_cancelled() {
            return Err(ModelError::Cancelled);
        }
        let refresh = provider
            .prepare_refresh(connection, self.credential.credential().clone())
            .map_err(|error| {
                diagnostics::provider(
                    "credential_refresh_prepare",
                    &error,
                    &self.credential.target().connection_id,
                    &self.credential.target().provider.name,
                );
                failure(error)
            })?;
        if !self.credential.claim_refresh().await.map_err(|error| {
            diagnostics::configuration(
                "credential_refresh_claim",
                &error,
                Some(&self.credential.target().connection_id),
            );
            failure(error)
        })? {
            let message = "Provider refresh was already claimed; its outcome is unknown";
            self.outcome = Outcome::Failed(message.into());
            return Err(failure(message));
        }
        // JS already drains its exchange deadline; native callbacks must also
        // settle within a bounded Host lifetime. A timeout never reuses a grant.
        let result = tokio::time::timeout(Duration::from_secs(90), refresh.run(context)).await;
        let replacement = match result {
            Ok(Ok(credential)) => credential,
            result => {
                let error = match result {
                    Ok(Err(error)) => {
                        diagnostics::provider(
                            "credential_refresh_exchange",
                            &error,
                            &self.credential.target().connection_id,
                            &self.credential.target().provider.name,
                        );
                        error.to_string()
                    }
                    Err(_) => {
                        tracing::warn!(
                            stage = "credential_refresh_exchange",
                            cause = "credential_refresh_timeout",
                            "Model preparation failed"
                        );
                        "Provider refresh outcome is unknown".into()
                    }
                    Ok(Ok(_)) => unreachable!(),
                };
                self.outcome = Outcome::Failed(error.clone());
                return Err(failure(error));
            }
        };
        self.outcome = Outcome::Replacement(replacement);
        self.settle().await?;
        Ok(self.credential.clone())
    }

    async fn settle(&mut self) -> Result<(), ModelError> {
        let Outcome::Replacement(replacement) = &self.outcome else {
            unreachable!("received replacement")
        };
        let current = self
            .credential
            .current_generation()
            .await
            .map_err(|error| {
                diagnostics::configuration(
                    "credential_generation_observation",
                    &error,
                    Some(&self.credential.target().connection_id),
                );
                failure(error)
            })?
            .ok_or_else(|| failure("Provider credential was superseded"))?;
        let next = self
            .credential
            .basis()
            .revision
            .checked_add(1)
            .ok_or_else(|| {
                tracing::warn!(
                    stage = "credential_refresh_commit",
                    cause = "credential_revision_exhausted",
                    "Model preparation failed"
                );
                failure("Provider credential revision exhausted")
            })?;
        // The complete envelope matters: refresh_at is Host scheduling authority.
        if current.basis().revision == next && current.credential() == replacement {
            self.credential = current;
            self.outcome = Outcome::Ready;
            return Ok(());
        }
        if current.basis() != self.credential.basis() {
            return Err(failure("Provider credential was superseded"));
        }
        self.credential
            .commit_refresh(replacement.clone(), now()?)
            .await
            .map_err(|error| {
                diagnostics::configuration(
                    "credential_refresh_commit",
                    &error,
                    Some(&self.credential.target().connection_id),
                );
                failure(error)
            })?
            .ok_or_else(|| failure("Provider credential was superseded"))?;
        let current = self
            .credential
            .current_generation()
            .await
            .map_err(|error| {
                diagnostics::configuration(
                    "credential_generation_observation",
                    &error,
                    Some(&self.credential.target().connection_id),
                );
                failure(error)
            })?
            .ok_or_else(|| failure("Provider credential was superseded"))?;
        if current.basis().revision != next || current.credential() != replacement {
            return Err(failure("Provider credential was superseded"));
        }
        self.credential = current;
        self.outcome = Outcome::Ready;
        Ok(())
    }
}

fn now() -> Result<u64, ModelError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|time| u64::try_from(time.as_millis()).ok())
        .filter(|time| *time <= 9_007_199_254_740_991)
        .ok_or_else(|| {
            tracing::warn!(
                stage = "credential_clock",
                cause = "credential_time_invalid",
                "Model preparation failed"
            );
            failure("Invalid system time for credentials")
        })
}

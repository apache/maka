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
use crate::effect_snapshot::same_test_basis;

impl PreparedOnboarding {
    pub async fn complete(self, models: Vec<ModelInfo>, now: u64) -> Result<OnboardingSaveResult> {
        validation::revision(now, false).map_err(ConfigError::Invalid)?;
        if models.is_empty() {
            return Ok(OnboardingSaveResult::Rejected {
                reason: OnboardingRejection::ModelUnavailable,
            });
        }
        let mut available = std::collections::HashSet::new();
        for model in &models {
            model.validate().map_err(ConfigError::Invalid)?;
            if !available.insert(model.id.clone()) {
                return Err(ConfigError::Invalid("duplicate discovered model".into()));
            }
        }
        let Self {
            store,
            material,
            original_revision,
        } = self;
        store
            .transaction(TransactionMode::Immediate, move |tx| {
                use OnboardingRejection as R;
                let reject = |reason| OnboardingSaveResult::Rejected { reason };
                let catalog = catalog::read(tx)?;
                let mut row = material.connection.clone();
                let previous = catalog
                    .connections
                    .iter()
                    .find(|r| r.connection_id == row.connection_id);
                if let Some(revision) = original_revision {
                    let Some(previous) = previous else {
                        return Ok(reject(R::ConnectionNotFound));
                    };
                    if previous.revision != revision {
                        return Ok(reject(R::Superseded));
                    }
                } else {
                    if catalog.connections.iter().any(|r| r.slug == row.slug) {
                        return Ok(reject(R::SlugTaken));
                    }
                    if previous.is_some() {
                        return Ok(reject(R::Superseded));
                    }
                }
                if material.credentials_changed(tx)? || material.network_changed(tx)? {
                    return Ok(reject(R::Superseded));
                }
                if let Some(previous) = previous {
                    row.enabled = previous.enabled;
                    row.revision = catalog::next_revision(previous.revision)?;
                    if row.configuration != previous.configuration {
                        row.model_overrides = None;
                    }
                } else {
                    row.enabled = true;
                }
                if row.models_fetched_at.is_none() && row.enabled_model_ids.is_empty() {
                    row.enabled_model_ids = models.iter().map(|model| model.id.clone()).collect();
                }
                row.models = models;
                row.model_source = Some(ModelDiscoverySource::Fetched);
                row.models_fetched_at = Some(now);
                if previous.is_none_or(|p| !same_test_basis(p, &row)) {
                    row.last_test = None;
                }
                catalog::write_entry(tx, &row)?;
                let target = catalog.default_target.or_else(|| {
                    row.enabled_model_ids
                        .first()
                        .filter(|_| {
                            row.enabled
                                && row.provider.scope == maka_plugin_core::scope::Scope::Profile
                        })
                        .map(|model| ConnectionTarget {
                            connection_id: row.connection_id.clone(),
                            model_id: model.clone(),
                        })
                });
                catalog::advance(tx, catalog.revision, target.as_ref())?;
                Ok(OnboardingSaveResult::Saved {
                    connection: OnboardedConnection {
                        connection_id: row.connection_id,
                        revision: row.revision,
                        slug: row.slug,
                        provider: row.provider,
                    },
                })
            })
            .await
    }
}

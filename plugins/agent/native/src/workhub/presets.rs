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

//! Reusable route choices. A route freezes the selected values in its original
//! assignment; editing this catalog never changes an accepted task.
use super::*;

use maka_agent_api::workhub::presets::*;
impl Hub {
    fn presets_key(&self) -> String {
        format!("{}presets", self.agent.0.prefix)
    }
    pub(super) async fn presets(&self) -> std::result::Result<Presets, String> {
        let record = self
            .agent
            .0
            .store
            .plugin_data(&namespace(), &self.presets_key())
            .await
            .map_err(|_| "workhub_store_unavailable")?;
        let revision = record.as_ref().map(|r| r.revision);
        let entries = match record.map(|r| r.data) {
            None | Some(Data::Deleted) => vec![],
            Some(Data::Present(value)) => {
                serde_json::from_value(value).map_err(|_| "workhub_presets_invalid")?
            }
        };
        Ok(Presets { revision, entries })
    }
    /// Resolve reusable intent only for a new route; accepted assignments keep
    /// their original exact selection independently of later preset edits.
    pub(super) async fn resolve_preset(
        &self,
        id: &str,
    ) -> std::result::Result<(Preset, crate::ModelSelection), String> {
        let preset = self
            .presets()
            .await?
            .entries
            .into_iter()
            .find(|preset| preset.id == id)
            .ok_or("workhub_preset_missing")?;
        if !preset.enabled {
            return Err("workhub_preset_disabled".into());
        }
        self.tasks
            .workers
            .get(&preset.worker)
            .and_then(Option::as_ref)
            .ok_or("workhub_worker_unavailable")?;
        let public_guard = self.agent.0.catalog.snapshot.read().await;
        let snapshot = public_guard
            .as_ref()
            .map_err(|_| "workhub_configuration_unavailable")?
            .clone();
        let connection = self
            .agent
            .0
            .configuration
            .catalog()
            .await
            .map_err(|_| "workhub_configuration_unavailable")?
            .connections
            .into_iter()
            .find(|connection| {
                connection.connection_id == preset.model.connection_id && connection.enabled
            })
            .ok_or("workhub_preset_connection_unavailable")?;
        drop(public_guard);
        if maka_providers::definition(&connection.provider, snapshot).is_err() {
            return Err("workhub_preset_connection_unavailable".into());
        }
        if !connection
            .enabled_model_ids
            .contains(&preset.model.model_id)
        {
            return Err("workhub_preset_model_unavailable".into());
        }
        let selection = crate::ModelSelection {
            connection_id: preset.model.connection_id.clone(),
            model_id: preset.model.model_id.clone(),
        };
        Ok((preset, selection))
    }
    pub(super) async fn save_presets(&self, input: Presets) -> std::result::Result<Result, String> {
        let mut ids = std::collections::BTreeSet::new();
        if input.entries.iter().any(|p| {
            p.id.is_empty()
                || !ids.insert(&p.id)
                || !p
                    .id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
                || p.name.trim().is_empty()
                || !self.tasks.workers.contains_key(&p.worker)
                || p.tools.iter().any(|s| s.is_empty())
                || p.tools
                    .iter()
                    .collect::<std::collections::BTreeSet<_>>()
                    .len()
                    != p.tools.len()
                || maka_agent_facts::configuration::validation::target(&p.model).is_err()
        }) {
            return Ok(Result::Invalid);
        }
        let committed = self
            .agent
            .0
            .store
            .plugin_data_batch(
                &namespace(),
                vec![Mutation {
                    key: self.presets_key(),
                    expected_revision: input.revision,
                    data: Data::Present(
                        serde_json::to_value(&input.entries)
                            .map_err(|_| "workhub_encoding_failed")?,
                    ),
                }],
            )
            .await;
        match committed {
            Ok(rows) => Ok(Result::Saved {
                snapshot: Presets {
                    revision: Some(rows[0].revision),
                    entries: input.entries,
                },
            }),
            Err(maka_event_log::StoreError::RevisionConflict { .. }) => Ok(Result::Conflict {
                snapshot: self.presets().await?,
            }),
            Err(_) => Err("workhub_presets_commit_unknown".into()),
        }
    }
}

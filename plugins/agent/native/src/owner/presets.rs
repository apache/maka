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
use maka_agent_api::preset::*;
use maka_event_log::{
    StoreError,
    connection::Query,
    writeback::{Notification, Prepared, Statement},
};
use rusqlite::{Connection, OptionalExtension, params};

fn decode_json<T: serde::de::DeserializeOwned>(text: String) -> Result<T, StoreError> {
    serde_json::from_str(&text).map_err(|e| StoreError::InvalidTransition(e.to_string()))
}
fn read(connection: &Connection, scope: &str, id: &PresetId) -> Result<Option<Preset>, StoreError> {
    let row = connection.query_row(
        "SELECT revision,name,description,instruction,model_json,thinking_json,enabled FROM agent_subagent_presets WHERE scope=?1 AND id=?2",
        params![scope, id.0.to_string()], |row| Ok((row.get::<_,i64>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,row.get::<_,String>(5)?,row.get::<_,bool>(6)?))
    ).optional()?;
    row.map(
        |(revision, name, description, instruction, model, thinking, enabled)| {
            Ok(Preset {
                id: id.clone(),
                revision: PresetRevision(revision as u64),
                name,
                description,
                instruction,
                model: decode_json(model)?,
                thinking_level: decode_json(thinking)?,
                enabled,
            })
        },
    )
    .transpose()
}
struct Read {
    scope: String,
    id: PresetId,
}
impl Query for Read {
    type Output = Option<Preset>;
    fn execute(self, connection: &Connection) -> Result<Self::Output, StoreError> {
        read(connection, &self.scope, &self.id)
    }
}
struct List {
    scope: String,
}
impl Query for List {
    type Output = Vec<PresetSummary>;
    fn execute(self, connection: &Connection) -> Result<Self::Output, StoreError> {
        let mut statement=connection.prepare("SELECT id,revision,name,description,model_json,thinking_json,enabled FROM agent_subagent_presets WHERE scope=?1 ORDER BY name")?;
        let rows = statement.query_map([self.scope], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, bool>(6)?,
            ))
        })?;
        rows.map(|row| {
            let (id, revision, name, description, model, thinking, enabled) = row?;
            Ok(PresetSummary {
                id: PresetId(
                    Uuid::parse_str(&id)
                        .map_err(|e| StoreError::InvalidTransition(e.to_string()))?,
                ),
                revision: PresetRevision(revision as u64),
                name,
                description,
                model: decode_json(model)?,
                thinking_level: decode_json(thinking)?,
                enabled,
                availability: PresetAvailability::Available,
            })
        })
        .collect()
    }
}
enum Change {
    Create(Preset),
    Update(Preset, PresetRevision),
    Delete(PresetDelete),
}
struct Write {
    scope: String,
    change: Change,
}
impl Statement for Write {
    type Value = PresetResult;
    type Output = PresetResult;
    fn execute(self, connection: &Connection) -> Result<Prepared<PresetResult>, StoreError> {
        let result = self.apply(connection)?;
        let changed = matches!(
            result,
            PresetResult::Saved { .. } | PresetResult::Deleted { .. }
        );
        Ok(Prepared {
            value: result,
            changed,
            notification: Notification::NONE,
        })
    }
    fn committed(value: PresetResult) -> PresetResult {
        value
    }
    fn isolated_rejection(_: &StoreError) -> bool {
        false
    }
}
impl Write {
    fn apply(self, connection: &Connection) -> Result<PresetResult, StoreError> {
        let (id, expected) = match &self.change {
            Change::Create(p) => (p.id.clone(), None),
            Change::Update(p, r) => (p.id.clone(), Some(*r)),
            Change::Delete(p) => (p.id.clone(), Some(p.expected_revision)),
        };
        if let Some(expected) = expected {
            let current = connection
                .query_row(
                    "SELECT revision FROM agent_subagent_presets WHERE scope=?1 AND id=?2",
                    params![self.scope, id.0.to_string()],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?;
            let Some(current) = current else {
                return Ok(PresetResult::NotFound);
            };
            if current as u64 != expected.0 {
                return Ok(PresetResult::Conflict {
                    actual: PresetRevision(current as u64),
                });
            }
        }
        let preset = match self.change {
            Change::Delete(_) => {
                connection.execute(
                    "DELETE FROM agent_subagent_presets WHERE scope=?1 AND id=?2",
                    params![self.scope, id.0.to_string()],
                )?;
                return Ok(PresetResult::Deleted { id });
            }
            Change::Create(p) | Change::Update(p, _) => p,
        };
        let exists:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM agent_subagent_presets WHERE scope=?1 AND name=?2 AND id<>?3)",params![self.scope,preset.name,id.0.to_string()],|r|r.get(0))?;
        if exists {
            return Ok(PresetResult::NameConflict);
        }
        let sql = if expected.is_none() {
            "INSERT INTO agent_subagent_presets
             (scope,id,revision,name,description,instruction,model_json,thinking_json,enabled)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)"
        } else {
            "UPDATE agent_subagent_presets SET revision=?3,name=?4,description=?5,
             instruction=?6,model_json=?7,thinking_json=?8,enabled=?9 WHERE scope=?1 AND id=?2"
        };
        connection.execute(
            sql,
            params![
                self.scope,
                id.0.to_string(),
                preset.revision.0 as i64,
                preset.name,
                preset.description,
                preset.instruction,
                serde_json::to_string(&preset.model)
                    .map_err(|e| StoreError::InvalidTransition(e.to_string()))?,
                serde_json::to_string(&preset.thinking_level)
                    .map_err(|e| StoreError::InvalidTransition(e.to_string()))?,
                preset.enabled,
            ],
        )?;
        Ok(PresetResult::Saved { preset })
    }
}
impl Owner {
    async fn preset_model_availability(
        &self,
        model: &ModelSelection,
        thinking: Option<maka_agent_facts::execution::ThinkingLevel>,
    ) -> Result<PresetAvailability, String> {
        let snapshot = self
            .catalog
            .snapshot
            .read()
            .await
            .as_ref()
            .map_err(|_| "agent_configuration_unavailable")?
            .clone();
        let catalog = self
            .configuration
            .catalog()
            .await
            .map_err(|e| e.to_string())?;
        Self::preset_model_in_catalog(model, thinking, &catalog, snapshot).await
    }
    async fn preset_model_in_catalog(
        model: &ModelSelection,
        thinking: Option<maka_agent_facts::execution::ThinkingLevel>,
        catalog: &maka_agent_facts::configuration::ConnectionCatalogSnapshot,
        snapshot: Arc<maka_providers::catalog::Snapshot>,
    ) -> Result<PresetAvailability, String> {
        let Some(row) = catalog.connections.iter().find(|r| {
            r.connection_id == model.connection_id
                && r.enabled
                && r.enabled_model_ids.contains(&model.model_id)
        }) else {
            return Ok(PresetAvailability::ModelUnavailable);
        };
        if maka_providers::definition(&row.provider, snapshot.clone()).is_err() {
            return Ok(PresetAvailability::ModelUnavailable);
        }
        let overrides = row
            .model_overrides
            .as_ref()
            .and_then(|all| all.get(&model.model_id))
            .cloned();
        let metadata =
            match maka_providers::model_metadata(row, &model.model_id, overrides, snapshot).await {
                Ok(value) => value,
                Err(_) => return Ok(PresetAvailability::ModelUnavailable),
            };
        Ok(
            if thinking.is_some_and(|level| !metadata.thinking_levels.contains(&level)) {
                PresetAvailability::ThinkingLevelUnavailable
            } else {
                PresetAvailability::Available
            },
        )
    }
    pub(crate) async fn presets(&self) -> Result<Vec<PresetSummary>, String> {
        let mut rows = self
            .store
            .data_writer()
            .map_err(|e| e.to_string())?
            .query(List {
                scope: self.prefix.clone(),
            })
            .await
            .map_err(|e| e.to_string())?;
        if !rows.iter().any(|row| row.enabled) {
            for row in &mut rows {
                row.availability = PresetAvailability::Disabled;
            }
            return Ok(rows);
        }
        let snapshot = self
            .catalog
            .snapshot
            .read()
            .await
            .as_ref()
            .map_err(|_| "agent_configuration_unavailable")?
            .clone();
        let catalog = self
            .configuration
            .catalog()
            .await
            .map_err(|e| e.to_string())?;
        let mut availability: BTreeMap<_, PresetAvailability> = BTreeMap::new();
        for row in &mut rows {
            row.availability = if row.enabled {
                let key = (
                    row.model.connection_id.clone(),
                    row.model.model_id.clone(),
                    serde_json::to_string(&row.thinking_level).map_err(|e| e.to_string())?,
                );
                if let Some(value) = availability.get(&key) {
                    value.clone()
                } else {
                    let value = Self::preset_model_in_catalog(
                        &row.model,
                        row.thinking_level,
                        &catalog,
                        snapshot.clone(),
                    )
                    .await?;
                    availability.insert(key, value.clone());
                    value
                }
            } else {
                PresetAvailability::Disabled
            };
        }
        Ok(rows)
    }
    pub(crate) async fn preset(&self, input: PresetRead) -> Result<Option<PresetDetail>, String> {
        let Some(preset) = self.read_preset(input.id).await? else {
            return Ok(None);
        };
        let availability = if preset.enabled {
            self.preset_model_availability(&preset.model, preset.thinking_level)
                .await?
        } else {
            PresetAvailability::Disabled
        };
        Ok(Some(PresetDetail {
            preset,
            availability,
        }))
    }
    async fn read_preset(&self, id: PresetId) -> Result<Option<Preset>, String> {
        self.store
            .data_writer()
            .map_err(|e| e.to_string())?
            .query(Read {
                scope: self.prefix.clone(),
                id,
            })
            .await
            .map_err(|e| e.to_string())
    }
    fn preset_change(
        &self,
        change: Change,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<NativeMutation<PresetResult>, String> {
        let writer = if let Some(execution) = scope.identity.agent() {
            let custody = scope.work_custody().ok_or("agent_work_unavailable")?;
            self.store
                .data_writer_for_work(custody.as_ref(), &execution.session_id)
        } else {
            self.store.data_writer()
        }
        .map_err(|e| e.to_string())?;
        let change = writer
            .prepare_result(|_| {
                Ok(Write {
                    scope: self.prefix.clone(),
                    change,
                })
            })
            .map_err(|e| e.to_string())?;
        Ok(NativeMutation::Computed { change })
    }
    async fn validate_preset(
        &self,
        preset: &mut Preset,
        model_changed: bool,
    ) -> Result<Option<PresetResult>, String> {
        preset.name = preset.name.trim().to_owned();
        if preset.name.is_empty() {
            return Ok(Some(PresetResult::InvalidInput {
                field: "name".into(),
            }));
        }
        if preset.description.trim().is_empty() {
            return Ok(Some(PresetResult::InvalidInput {
                field: "description".into(),
            }));
        }
        if model_changed {
            return Ok(
                match self
                    .preset_model_availability(&preset.model, preset.thinking_level)
                    .await?
                {
                    PresetAvailability::Available => None,
                    PresetAvailability::ThinkingLevelUnavailable => {
                        Some(PresetResult::ThinkingLevelUnavailable)
                    }
                    _ => Some(PresetResult::ModelUnavailable),
                },
            );
        }
        Ok(None)
    }
    pub(crate) async fn create_preset(
        &self,
        input: PresetCreate,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<NativeMutation<PresetResult>, String> {
        let mut preset = Preset {
            id: PresetId(Uuid::new_v4()),
            revision: PresetRevision(1),
            name: input.name,
            description: input.description,
            instruction: input.instruction,
            model: input.model,
            thinking_level: input.thinking_level,
            enabled: input.enabled,
        };
        if let Some(result) = self.validate_preset(&mut preset, true).await? {
            return Ok(NativeMutation::Returned(result));
        }
        self.preset_change(Change::Create(preset), scope)
    }
    pub(crate) async fn update_preset(
        &self,
        input: PresetUpdate,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<NativeMutation<PresetResult>, String> {
        let Some(mut preset) = self.read_preset(input.id).await? else {
            return Ok(NativeMutation::Returned(PresetResult::NotFound));
        };
        if preset.revision != input.expected_revision {
            return Ok(NativeMutation::Returned(PresetResult::Conflict {
                actual: preset.revision,
            }));
        }
        let model_changed = input.model.is_some() || input.thinking_level.is_some();
        if let Some(value) = input.name {
            preset.name = value;
        }
        if let Some(value) = input.description {
            preset.description = value;
        }
        if let Some(value) = input.instruction {
            preset.instruction = value;
        }
        if let Some(value) = input.model {
            preset.model = value;
        }
        if let Some(value) = input.thinking_level {
            preset.thinking_level = match value {
                PresetThinkingChange::Default => None,
                PresetThinkingChange::Set { value } => Some(value),
            };
        }
        if let Some(value) = input.enabled {
            preset.enabled = value;
        }
        if let Some(result) = self.validate_preset(&mut preset, model_changed).await? {
            return Ok(NativeMutation::Returned(result));
        }
        let Some(revision) = preset
            .revision
            .0
            .checked_add(1)
            .filter(|r| *r <= 9_007_199_254_740_991)
        else {
            return Ok(NativeMutation::Returned(PresetResult::InvalidInput {
                field: "revision".into(),
            }));
        };
        preset.revision = PresetRevision(revision);
        self.preset_change(Change::Update(preset, input.expected_revision), scope)
    }
    pub(crate) fn delete_preset(
        &self,
        input: PresetDelete,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<NativeMutation<PresetResult>, String> {
        self.preset_change(Change::Delete(input), scope)
    }
}

#[cfg(test)]
mod tests;

pub(super) struct CreationFence {
    pub scope: String,
    pub id: PresetId,
    pub revision: PresetRevision,
}
impl CreationFence {
    pub(super) fn check(&self, connection: &Connection) -> Result<Option<Rejection>, StoreError> {
        let current = connection
            .query_row(
                "SELECT revision FROM agent_subagent_presets WHERE scope=?1 AND id=?2",
                params![self.scope, self.id.0.to_string()],
                |r| r.get::<_, i64>(0),
            )
            .optional()?;
        Ok(match current {
            None => Some(Rejection::PresetNotFound),
            Some(revision) if revision as u64 != self.revision.0 => Some(Rejection::PresetConflict),
            Some(_) => None,
        })
    }
}

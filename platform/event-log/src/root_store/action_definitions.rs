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

use super::{DataChange, RootStore};
use crate::{
    StoreError,
    writeback::{Notification, Prepared, Statement},
};
use maka_plugin_core::actions::{ActionDefinition, ActionId};
use rusqlite::{Connection, params};
use std::sync::Arc;

/// An Action definition mutation to commit with its original operation receipt.
#[derive(Debug)]
pub enum ActionDefinitionChange {
    Create(ActionDefinition),
    Update {
        definition: ActionDefinition,
        expected_revision: u64,
    },
    Remove {
        project: String,
        id: ActionId,
        expected_revision: u64,
    },
}

impl RootStore {
    pub async fn action_definitions(
        &self,
        project: &str,
    ) -> Result<Vec<ActionDefinition>, StoreError> {
        self.require_open()?;
        let project = project.to_owned();
        self.log
            .connection
            .read(move |db| {
                db.prepare_cached(
                    "SELECT record_json FROM project_actions WHERE project_id=? ORDER BY id",
                )?
                .query_map([project], |row| row.get::<_, String>(0))?
                .map(|raw| Ok(serde_json::from_str(&raw?)?))
                .collect()
            })
            .await
    }
    /// Prepare the mutation without writing to SQLite. The receipt value receives
    /// the saved definition for create/update and `None` for remove.
    pub fn prepare_action_definition<T: serde::Serialize + Send + 'static>(
        &self,
        change: ActionDefinitionChange,
        result: impl FnOnce(Option<ActionDefinition>) -> T + Send + 'static,
    ) -> Result<DataChange, StoreError> {
        self.data_writer()?
            .prepare_result(|_| Ok(WriteActionDefinition { change, result }))
    }
}

struct WriteActionDefinition<F> {
    change: ActionDefinitionChange,
    result: F,
}

impl<F, T> Statement for WriteActionDefinition<F>
where
    F: FnOnce(Option<ActionDefinition>) -> T + Send + 'static,
    T: Send + 'static,
{
    type Value = T;
    type Output = T;

    fn execute(self, db: &Connection) -> Result<Prepared<T>, StoreError> {
        let (changed, definition) = match self.change {
            ActionDefinitionChange::Create(definition) => {
                let raw = serde_json::to_string(&definition)?;
                let changed = db.execute(
                    "INSERT OR IGNORE INTO project_actions(id,project_id,revision,record_json)
                     VALUES(?,?,?,?)",
                    params![
                        definition.id.to_string(),
                        definition.project_id,
                        definition.revision as i64,
                        raw
                    ],
                )?;
                (changed, Some(definition))
            }
            ActionDefinitionChange::Update {
                definition,
                expected_revision,
            } => {
                let raw = serde_json::to_string(&definition)?;
                let changed = db.execute(
                    "UPDATE project_actions SET revision=?,record_json=?
                     WHERE id=? AND project_id=? AND revision=?",
                    params![
                        definition.revision as i64,
                        raw,
                        definition.id.to_string(),
                        definition.project_id,
                        expected_revision as i64
                    ],
                )?;
                (changed, Some(definition))
            }
            ActionDefinitionChange::Remove {
                project,
                id,
                expected_revision,
            } => (
                db.execute(
                    "DELETE FROM project_actions WHERE project_id=? AND id=? AND revision=?",
                    params![project, id.to_string(), expected_revision as i64],
                )?,
                None,
            ),
        };
        if changed != 1 {
            return Err(rejected("Action definition changed"));
        }
        if let Some(definition) = &definition {
            check_action_capacity(
                db,
                &definition.project_id,
                "Project Action definitions exceed the configuration limit",
            )?;
        }
        Ok(Prepared {
            value: (self.result)(definition),
            changed: true,
            notification: Notification::NONE,
        })
    }

    fn committed(value: T) -> T {
        value
    }

    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(error, StoreError::StatementRejected { .. })
    }
}

pub(crate) fn merge_action_definitions(
    db: &Connection,
    source: &str,
    absorbed: &str,
) -> Result<(), StoreError> {
    let moved = db.execute(
        "UPDATE project_actions SET project_id=?1, record_json=json_set(record_json,'$.projectId',?1)
         WHERE project_id=?2",
        params![source, absorbed],
    )?;
    if moved != 0 {
        check_action_capacity(
            db,
            source,
            "Combined Project Actions exceed the configuration limit. Reduce the Actions before relinking.",
        )?;
    }
    Ok(())
}

fn check_action_capacity(
    db: &Connection,
    project: &str,
    diagnostic: &str,
) -> Result<(), StoreError> {
    let (count, bytes): (i64, i64) = db.query_row(
        "SELECT count(*),coalesce(sum(length(CAST(record_json AS BLOB))),0) FROM project_actions WHERE project_id=?",
        [project], |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if count > 128 || bytes + count > 48 * 1024 {
        return Err(rejected(diagnostic));
    }
    Ok(())
}

fn rejected(diagnostic: &str) -> StoreError {
    StoreError::StatementRejected {
        diagnostic: diagnostic.into(),
        cause: Arc::new(StoreError::InvalidTransition(diagnostic.into())),
    }
}

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

use crate::{
    Error,
    command::{Query, QueryResult},
    invalid,
    repository::Catalog,
    task::Task,
};
use std::{collections::BTreeMap, sync::Arc};

#[derive(Default)]
pub struct View {
    pub revision: u64,
    pub tasks: BTreeMap<String, Arc<Task>>,
    pub(crate) task_versions: BTreeMap<String, TaskVersion>,
    pub error: Option<String>,
    pub ready: bool,
    pub pending_work: bool,
}
#[derive(Clone)]
pub(crate) struct TaskVersion {
    revision: u64,
    timezone: String,
}
impl View {
    pub(crate) fn committed(catalog: &Catalog, previous: &Self) -> Self {
        let tasks = catalog
            .plans
            .iter()
            .map(|(id, saved)| {
                let task = previous
                    .tasks
                    .get(id)
                    .filter(|task| ***task == saved.plan.task)
                    .cloned()
                    .unwrap_or_else(|| Arc::new(saved.plan.task.clone()));
                (id.clone(), task)
            })
            .collect();
        Self {
            revision: catalog.revision.unwrap_or(0),
            tasks,
            task_versions: catalog
                .plans
                .iter()
                .map(|(id, saved)| {
                    (
                        id.clone(),
                        TaskVersion {
                            revision: saved.revision,
                            timezone: saved.plan.timezone.clone(),
                        },
                    )
                })
                .collect(),
            error: None,
            ready: true,
            pending_work: catalog.plans.values().any(|saved| {
                saved.plan.pending.is_some()
                    || saved.plan.task.status == crate::task::Status::Active
            }),
        }
    }
    pub fn query(&self, query: Query) -> Result<QueryResult, Error> {
        if !self.ready {
            return Err(Error::Unavailable(
                self.error
                    .clone()
                    .unwrap_or_else(|| "scheduler is recovering".into()),
            ));
        }
        query.validate()?;
        match query {
            Query::Get { task_id } => Ok(QueryResult::Task {
                revision: self
                    .task_versions
                    .get(&task_id)
                    .map(|version| version.revision),
                timezone: self
                    .task_versions
                    .get(&task_id)
                    .map(|version| version.timezone.clone()),
                task: self
                    .tasks
                    .get(&task_id)
                    .map(|task| Box::new((**task).clone())),
            }),
            Query::List {
                cursor,
                expected_revision,
            } => {
                if let Some(expected) = expected_revision
                    && expected != self.revision
                {
                    return Ok(QueryResult::RevisionChanged {
                        expected,
                        actual: self.revision,
                    });
                }
                let offset = cursor
                    .as_deref()
                    .unwrap_or("0")
                    .parse::<usize>()
                    .map_err(|_| invalid("invalid task page cursor"))?;
                if offset > self.tasks.len() {
                    return Err(invalid("unknown task page cursor"));
                }
                // Reserve envelope headroom; a page is constrained by bytes as well as count.
                let mut remaining: usize = 87 * 1024;
                let mut tasks = Vec::new();
                let mut next_cursor = None;
                for task in self.tasks.values().skip(offset) {
                    let bytes = serde_json::to_vec(task.as_ref())
                        .map_err(|error| invalid(error.to_string()))?
                        .len()
                        + 1;
                    if tasks.len() == 64 || (!tasks.is_empty() && bytes > remaining) {
                        next_cursor = Some((offset + tasks.len()).to_string());
                        break;
                    }
                    remaining = remaining.saturating_sub(bytes);
                    tasks.push((**task).clone());
                }
                Ok(QueryResult::Page {
                    revision: self.revision,
                    tasks,
                    next_cursor,
                })
            }
        }
    }
}

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

//! Live task views retain the exact page or task input; each update is a fresh authorized query.
use super::*;
impl Hub {
    pub(super) async fn watch(
        &self,
        input: Value,
        detail: bool,
        context: &Context,
    ) -> Result<Value, String> {
        let task: Option<contract::TaskRead> = if detail {
            Some(serde_json::from_value(input.clone()).map_err(|_| "workhub_input_invalid")?)
        } else {
            None
        };
        let after = if detail {
            None
        } else {
            serde_json::from_value::<contract::TasksRead>(input)
                .map_err(|_| "workhub_input_invalid")?
                .after
        };
        let stop = &context.scope().cancellation;
        let mut commits = self.agent.0.store.subscribe_changes();
        let mut previous = None;
        loop {
            if stop.is_cancelled() {
                return Err("workhub_observation_cancelled".into());
            }
            let value = match &task {
                Some(task) => {
                    self.task(&task.task_id, false, task.cursor.clone(), stop.clone())
                        .await?
                }
                None => self.task_list(after.clone()).await?,
            };
            if previous.as_ref() != Some(&value) {
                context.emit(value.clone()).await?;
                previous = Some(value);
            }
            tokio::select! {
                () = stop.cancelled() => return Err("workhub_observation_cancelled".into()),
                changed = commits.changed() => changed.map_err(|_| "workhub_observation_closed")?,
                () = tokio::time::sleep(std::time::Duration::from_secs(2)) => {},
            }
            // Bound query fan-out while a worker streams. Remote workers without
            // local commits are still observed by the same periodic read.
            tokio::select! {
                () = stop.cancelled() => return Err("workhub_observation_cancelled".into()),
                () = tokio::time::sleep(std::time::Duration::from_millis(250)) => {},
            }
            commits.borrow_and_update();
        }
    }
}

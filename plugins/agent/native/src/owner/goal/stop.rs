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
use maka_agent_state::{StopOutcome, StopRun};

impl Owner {
    pub(in crate::owner) async fn prepare_stop_with_goal(
        self: &Arc<Self>,
        session: &str,
        stop: StopRun,
    ) -> Result<NativeMutation<Stopped>, String> {
        self.prepare_stop_with_goal_mapped(session, stop, std::convert::identity)
            .await
    }

    pub(in crate::owner) async fn prepare_stop_with_goal_mapped<U, M>(
        self: &Arc<Self>,
        session: &str,
        stop: StopRun,
        map: M,
    ) -> Result<NativeMutation<U>, String>
    where
        U: Serialize + std::marker::Send + 'static,
        M: FnOnce(Stopped) -> U + std::marker::Send + 'static,
    {
        let gate = Arc::new(self.goals.gate.clone().lock_owned().await);
        let pause = match self.goals.repository.read(session).await.map_err(reason)? {
            Some(mut saved) if saved.goal.status == Status::Active => {
                saved.goal.control(GoalControl::Pause).map_err(reason)?;
                let (revision, index) = self
                    .goals
                    .repository
                    .schedule_snapshot()
                    .await
                    .map_err(reason)?;
                Repository::prepare_save(saved, revision, index).map_err(reason)?
            }
            _ => vec![],
        };
        let writer = self.store.data_writer().map_err(reason)?;
        let change = writer
            .prepare_result(|writer| {
                Ok(StopWithGoal {
                    stop,
                    pause,
                    writer,
                    gate,
                    goals: self.goals.clone(),
                    map,
                })
            })
            .map_err(reason)?;
        Ok(NativeMutation::Computed { change })
    }
}

struct StopWithGoal<M> {
    stop: StopRun,
    pause: Vec<Mutation>,
    writer: DataWriter,
    gate: Arc<tokio::sync::OwnedMutexGuard<()>>,
    goals: Arc<Goals>,
    map: M,
}
#[derive(Serialize)]
#[serde(transparent)]
struct StopCompletion<U> {
    result: U,
    #[serde(skip)]
    changed_goal: Option<Arc<Goals>>,
}
impl<U, M> Statement for StopWithGoal<M>
where
    U: Serialize + std::marker::Send + 'static,
    M: FnOnce(Stopped) -> U + std::marker::Send + 'static,
{
    type Value = StopCompletion<U>;
    type Output = U;

    fn retain(&self) -> Vec<Arc<dyn std::marker::Send + Sync>> {
        vec![self.gate.clone()]
    }
    fn execute(
        self,
        connection: &rusqlite::Connection,
    ) -> Result<Prepared<Self::Value>, StoreError> {
        let stopped = self.stop.execute(connection)?;
        let mut changed = stopped.changed;
        let mut notification = stopped.notification;
        let changed_goal = if matches!(stopped.value, StopOutcome::Requested { latest: true })
            && !self.pause.is_empty()
        {
            let paused = self
                .goals
                .storage
                .prepare_statement(self.pause, &self.writer)?
                .execute(connection)?;
            changed |= paused.changed;
            notification = notification.combine(paused.notification);
            Some(self.goals)
        } else {
            None
        };
        let requested = !matches!(stopped.value, StopOutcome::Inactive);
        Ok(Prepared {
            value: StopCompletion {
                result: (self.map)(Stopped { requested }),
                changed_goal,
            },
            changed,
            notification,
        })
    }
    fn committed(value: Self::Value) -> U {
        if let Some(goals) = value.changed_goal {
            goals.written();
        }
        value.result
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        StopRun::isolated_rejection(error)
    }
}

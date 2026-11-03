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

use crate::RunError;
use maka_agent_facts::event::Invocation;
use maka_event_log::root_store::SessionStore;
use std::sync::{Arc, Mutex};
use tokio_util::{sync::CancellationToken, task::AbortOnDropHandle};

pub(super) struct Steering {
    pub signal: CancellationToken,
    failure: Arc<Mutex<Option<RunError>>>,
    _watcher: AbortOnDropHandle<()>,
}

impl Steering {
    pub async fn watch(
        log: Arc<SessionStore>,
        invocation: Invocation,
        stop: CancellationToken,
    ) -> Result<Self, RunError> {
        let mut commits = log.subscribe_session_commits(&invocation.session_id)?;
        let signal = CancellationToken::new();
        let failure = Arc::new(Mutex::new(None));
        let wake = signal.clone();
        let error = failure.clone();
        let watcher = tokio::spawn(async move {
            let result = async {
                loop {
                    if log.has_pending_steering(&invocation).await? {
                        close_interactions(&log, &invocation).await?;
                        wake.cancel();
                        return Ok::<_, RunError>(());
                    }
                    tokio::select! {
                        biased;
                        _ = stop.cancelled() => return Ok(()),
                        changed = commits.changed() => changed.map_err(|_| RunError::Internal("steering observation closed".into()))?,
                    }
                }
            }.await;
            if let Err(reason) = result {
                *error.lock().unwrap() = Some(reason);
                wake.cancel();
            }
        });
        Ok(Self {
            signal,
            failure,
            _watcher: AbortOnDropHandle::new(watcher),
        })
    }

    pub fn check(&self) -> Result<(), RunError> {
        match self.failure.lock().unwrap().take() {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

pub(super) async fn close_interactions(
    log: &SessionStore,
    invocation: &Invocation,
) -> Result<(), RunError> {
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| RunError::Internal(error.to_string()))?
        .as_millis() as u64;
    log.close_run_interactions(
        invocation,
        maka_agent_facts::interaction::ClosureReason::Steered,
        at,
    )
    .await?;
    Ok(())
}

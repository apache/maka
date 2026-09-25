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

use super::{Executions, Result, internal};
use crate::session::SessionConfiguration;
use maka_event_log::sessions::SessionRetirement;
use std::{sync::Arc, time::Duration};

impl Executions {
    /// The accepted worker owns commit, notifications and recovery scheduling,
    /// even if the Remote or plugin stops waiting for its receipt.
    pub(crate) async fn remove_family(
        self: &Arc<Self>,
        session: String,
        expected: u64,
        authority: maka_event_log::sessions::RemovalAuthority,
        admission: tokio::sync::OwnedMutexGuard<()>,
    ) -> Result<maka_event_log::sessions::RemoveFamilyResult> {
        let worker = self.clone();
        let (send, receive) = tokio::sync::oneshot::channel();
        self.workers.spawn(async move {
            let result = if worker.accepting() {
                worker
                    .log
                    .remove_session_family(&session, expected, authority)
                    .await
                    .map_err(|error| {
                        if matches!(
                            error,
                            maka_event_log::StoreError::CommitUnknown(_)
                                | maka_event_log::StoreError::OperationUnknown
                        ) {
                            worker.begin_drain();
                        }
                        if matches!(error, maka_event_log::StoreError::PrefixTooLarge) {
                            super::failure(
                                maka_protocol::OperationErrorCode::OperationConflict,
                                "Session removal exceeds the family size limit",
                            )
                        } else {
                            use maka_event_log::StoreError;
                            use maka_protocol::OperationErrorCode as Code;
                            let code = match error {
                                StoreError::SessionConflict | StoreError::SessionRetired => {
                                    Code::OperationConflict
                                }
                                StoreError::SessionNotFound => Code::NotFound,
                                StoreError::SessionBusy => Code::SessionBusy,
                                StoreError::CommitUnknown(_) | StoreError::OperationUnknown => {
                                    Code::CommitOutcomeUnknown
                                }
                                _ => Code::PersistenceFailed,
                            };
                            super::failure(code, &error.to_string())
                        }
                    })
            } else {
                Err(super::failure(
                    maka_protocol::OperationErrorCode::HostDraining,
                    "Host is draining",
                ))
            };
            if let Ok(maka_event_log::sessions::RemoveFamilyResult::Accepted(plan)) = &result {
                for session in plan.remove.iter().chain(&plan.archive) {
                    // A receipt retry must not retire a dependent that the user
                    // restored after the original removal finished.
                    match worker.log.session_retirement(session).await {
                        Ok(Some(_)) => worker
                            .capabilities
                            .registry
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .release_session(session),
                        Ok(None) => {}
                        Err(_) => worker.begin_drain(),
                    }
                }
            }
            drop(admission);
            if let Ok(maka_event_log::sessions::RemoveFamilyResult::Accepted(plan)) = &result {
                worker.request_removal_recovery();
                for session in plan.remove.iter().chain(&plan.archive) {
                    worker.publish_session_change(session).await;
                }
            }
            let _ = send.send(result);
        });
        receive.await.map_err(|_| {
            super::failure(
                maka_protocol::OperationErrorCode::CommitOutcomeUnknown,
                "Session removal owner disappeared",
            )
        })?
    }

    pub(crate) fn request_removal_recovery(&self) {
        self.removal_wake.notify_one();
    }

    pub(crate) fn start_removal_recovery(self: &Arc<Self>) {
        let host = self.clone();
        self.workers.spawn(async move {
            let mut pending = false;
            let mut delay = Duration::from_millis(250);
            loop {
                tokio::select! {
                    biased;
                    _ = host.shutdown.cancelled() => break,
                    _ = host.removal_wake.notified() => { delay = Duration::from_millis(250); }
                    _ = tokio::time::sleep(delay), if pending => {
                        delay = (delay * 2).min(Duration::from_secs(30));
                    }
                }
                match host.recover_removals().await {
                    Ok(remaining) => pending = remaining,
                    Err(error) => {
                        host.begin_drain();
                        eprintln!("Session removal recovery failed: {}", error.message);
                        break;
                    }
                }
            }
        });
        self.request_removal_recovery();
    }

    async fn recover_removals(&self) -> Result<bool> {
        let mut after = None;
        let mut pending = false;
        loop {
            let page = self
                .log
                .pending_session_retirements(after.as_deref())
                .await
                .map_err(internal)?;
            if page.is_empty() {
                // The same recovery owner drains small material batches. Copied
                // history pins may defer collection until their last owner retires.
                let mut cursor = None;
                while self.accepting() {
                    use maka_event_log::sessions::MaterialCollection;
                    match self
                        .log
                        .collect_session_material(cursor.as_deref())
                        .await
                        .map_err(internal)?
                    {
                        MaterialCollection::Done => break,
                        MaterialCollection::Retained(session) => cursor = Some(session),
                        MaterialCollection::Collected => {}
                    }
                    tokio::task::yield_now().await;
                }
                return Ok(pending);
            }
            for session in page {
                after = Some(session.clone());
                if !self.accepting() {
                    return Ok(true);
                }
                if !self.drain_retiring_session(&session).await? {
                    pending = true;
                    continue;
                }
                self.capabilities
                    .registry
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .release_session(&session);
                pending |= !self.clean_removed_session(&session).await?;
            }
        }
    }

    async fn clean_removed_session(&self, session: &str) -> Result<bool> {
        let admission = self.lock_admission().await;
        if !self
            .log
            .session_retirement_ready(session)
            .await
            .map_err(internal)?
        {
            return Ok(false);
        }
        let Some(record) = self
            .log
            .retiring_session::<SessionConfiguration>(session)
            .await
            .map_err(internal)?
        else {
            return Ok(true);
        };
        let retirement = self
            .log
            .session_retirement(session)
            .await
            .map_err(internal)?;
        if retirement == Some(SessionRetirement::Removing)
            && let Some(binding) = record.configuration.worktree
        {
            let shared = self
                .log
                .workspace_has_other_session(&record.configuration.workspace.host_cwd, session)
                .await
                .map_err(internal)?;
            if !shared {
                // New owners need a live parent and a binding; path-only roots
                // cannot adopt this allocation. The durable fence has retired
                // the last parent, so filesystem I/O needs no global gate.
                drop(admission);
                let root = self.paths.state_root.join("subagent-worktrees");
                let cleanup = tokio::task::spawn_blocking(move || {
                    maka_fs_tools::worktree::Worktrees::open(&root)?.remove(&binding)
                })
                .await
                .map_err(internal)?;
                if let Err(error) = cleanup {
                    eprintln!("Session {session} workspace cleanup pending: {error}");
                    return Ok(false);
                }
            }
        }
        let retired = !self
            .log
            .finish_session_retirement(session)
            .await
            .map_err(internal)?
            .pending();
        if retired {
            self.engine.release_code_store(session);
            self.publish_session_change(session).await;
        }
        Ok(retired)
    }
}

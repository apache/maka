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

//! The durable Host queue is the only input authority; native writes never create messages.
use super::*;
use maka_event_log::{SessionStore, SessionSubscription};

pub(super) struct Steering {
    store: SessionStore,
    invocation: maka_agent_facts::event::Invocation,
    language: maka_agent_facts::language::Language,
    commits: SessionSubscription,
    cancellation: CancellationToken,
    directories: Vec<PathBuf>,
    observed_idle: bool,
}
impl Steering {
    pub fn new(
        store: SessionStore,
        request: &Request,
        cancellation: CancellationToken,
    ) -> Result<Self, Error> {
        let commits = store
            .subscribe_session_commits(&request.invocation.session_id)
            .map_err(|e| Error::Persistence(e.to_string()))?;
        Ok(Self {
            store,
            invocation: request.invocation.clone(),
            language: request.language,
            commits,
            cancellation,
            directories: Vec::new(),
            observed_idle: false,
        })
    }
    // Only observations belong in select!: a losing branch must not consume an admission.
    pub async fn ready(&mut self) -> Result<(), Error> {
        loop {
            if self.observed_idle {
                self.commits
                    .changed()
                    .await
                    .map_err(|_| Error::Persistence("steering observation closed".into()))?;
                self.observed_idle = false;
            }
            if self
                .store
                .has_pending_steering(&self.invocation)
                .await
                .map_err(|e| Error::Persistence(e.to_string()))?
            {
                return Ok(());
            }
            self.observed_idle = true;
        }
    }
    pub async fn take(&mut self) -> Result<Option<Value>, Error> {
        self.observed_idle = false;
        if self.cancellation.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let sources = self
            .store
            .commit_pending_steering(&self.invocation)
            .await
            .map_err(|e| Error::Persistence(e.to_string()))?;
        if sources.is_empty() {
            return Ok(None);
        }
        let at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| Error::Provider(e.to_string()))?
            .as_millis() as u64;
        self.store
            .close_run_interactions(
                &self.invocation,
                maka_agent_facts::interaction::ClosureReason::Steered,
                at,
            )
            .await
            .map_err(|e| Error::Persistence(e.to_string()))?;
        let content = maka_agent_facts::message::attributed_content(&sources, self.language);
        let mut materials = attachments::prepare(
            &self.store,
            &self.invocation.session_id,
            &content,
            &self.cancellation,
        )
        .await?;
        let value = serde_json::json!({"message":materials.message,"images":materials.images});
        if let Some(directory) = materials.handoff() {
            self.directories.push(directory);
        }
        Ok(Some(value))
    }
    pub async fn cleanup(&mut self) -> Result<(), Error> {
        for directory in self.directories.drain(..) {
            tokio::fs::remove_dir_all(directory).await.map_err(|e| {
                Error::Provider(format!("External steering attachment cleanup failed: {e}"))
            })?;
        }
        Ok(())
    }
}

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
use maka_js_runtime::repl::Repl;
use std::sync::Mutex;

#[derive(Default)]
pub(super) struct Sessions {
    entries: Mutex<BTreeMap<String, Arc<Interaction>>>,
    pub input: Arc<tokio::sync::Mutex<()>>,
    pub driver: Arc<tokio::sync::Mutex<maka_computer_use::Driver>>,
}
pub(super) struct Interaction {
    pub repl: tokio::sync::Mutex<Option<Repl>>,
    pub native: Arc<tokio::sync::Mutex<maka_computer_use::Session>>,
    pub retiring: CancellationToken,
}
impl Sessions {
    pub async fn state(&self, session: &str) -> ReplState {
        let interaction = self.entries.lock().unwrap().get(session).cloned();
        let Some(interaction) = interaction else {
            return ReplState::Fresh;
        };
        match interaction.repl.lock().await.as_ref() {
            None => ReplState::Fresh,
            Some(repl) if repl.is_closed() || interaction.retiring.is_cancelled() => {
                ReplState::ResetRequired
            }
            Some(_) => ReplState::Ready,
        }
    }
    pub fn get(&self, session: &str) -> Result<Arc<Interaction>, ToolError> {
        let mut entries = self.entries.lock().unwrap();
        if let Some(existing) = entries.get(session) {
            return if existing.retiring.is_cancelled() {
                Err(failed("Computer Session is retiring"))
            } else {
                Ok(existing.clone())
            };
        }
        if entries.len() >= 16 {
            return Err(failed(
                "Computer Use session capacity reached; retire an unused Session",
            ));
        }
        let interaction = Arc::new(Interaction {
            repl: Default::default(),
            native: Arc::new(tokio::sync::Mutex::new(maka_computer_use::Session::new(
                self.driver.clone(),
            ))),
            retiring: CancellationToken::new(),
        });
        entries.insert(session.into(), interaction.clone());
        Ok(interaction)
    }
    async fn retire(&self, id: &str, interaction: &Arc<Interaction>) -> Result<(), ToolError> {
        interaction.retiring.cancel();
        interaction.close().await?;
        let mut entries = self.entries.lock().unwrap();
        if entries
            .get(id)
            .is_some_and(|current| Arc::ptr_eq(current, interaction))
        {
            entries.remove(id);
        }
        Ok(())
    }
    pub async fn close(&self) -> Result<(), ToolError> {
        let entries = self.entries.lock().unwrap().clone();
        for entry in entries.values() {
            entry.retiring.cancel();
        }
        let mut failure = None;
        for (id, entry) in entries {
            if let Err(error) = self.retire(&id, &entry).await {
                failure.get_or_insert(error);
            }
        }
        if let Err(error) = self.driver.lock().await.close().await {
            failure.get_or_insert(error);
        }
        failure.map_or(Ok(()), Err)
    }
}
impl Interaction {
    pub async fn close(&self) -> Result<(), ToolError> {
        let mut repl = self.repl.lock().await;
        if let Some(runtime) = repl.take() {
            runtime
                .close()
                .await
                .map_err(|e| ToolError::CleanupUnconfirmed(message(e)))?;
        }
        *repl = None;
        self.native.lock().await.close().await
    }
}

pub(super) fn watch(owner: &Arc<Computer>) {
    let mut changes = owner.store.subscribe_catalog_changes();
    let stopping = owner.stopping.clone();
    let weak = Arc::downgrade(owner);
    owner.tasks.spawn(async move {
        loop {
            changes.borrow_and_update();
            let Some(owner) = weak.upgrade() else {
                return;
            };
            let entries = owner.sessions.entries.lock().unwrap().clone();
            for (id, entry) in entries {
                let valid = async {
                    let store = owner.store.session(&id).await?;
                    let session = store
                        .get_session::<maka_agent_api::session::StoredSessionConfiguration>(&id)
                        .await?;
                    let retired = store.session_retirement(&id).await?;
                    Ok::<_, maka_event_log::StoreError>(
                        session.is_some_and(|s| !s.archived) && retired.is_none(),
                    )
                }
                .await;
                if !matches!(valid, Ok(true)) {
                    let Ok(mut ticket) = owner.resources.reserve() else {
                        return;
                    };
                    ticket.start();
                    let result = owner.sessions.retire(&id, &entry).await.map_err(message);
                    let failed = result.is_err();
                    if failed {
                        owner.stopping.cancel();
                    }
                    ticket.complete(result);
                    if failed {
                        return;
                    }
                }
            }
            drop(owner);
            tokio::select! {
                () = stopping.cancelled() => return,
                result = changes.changed() => if result.is_err() { return; },
            }
        }
    });
}

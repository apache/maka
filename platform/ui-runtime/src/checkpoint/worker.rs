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
use std::sync::Mutex;
use tokio::sync::{Notify, watch};

enum Request {
    Load,
    Save(Box<Save>),
}
#[derive(Default)]
struct Pending {
    request: Option<Request>,
    closed: bool,
    unsaved: Option<String>,
}
struct Mailbox {
    pending: Mutex<Pending>,
    wake: Notify,
}
pub(super) struct Worker {
    mailbox: Arc<Mailbox>,
    reply: watch::Receiver<Option<Reply>>,
}
impl Worker {
    pub fn start(
        scope: Scope,
        policy: EditorPersistence,
        resources: &Arc<Resources>,
        budget: NativeBudget,
    ) -> Result<Self, String> {
        let store = scope
            .store
            .upgrade()
            .ok_or("original UI Root is no longer available")?;
        let mut ticket = resources.reserve().map_err(|error| error.to_string())?;
        let mailbox = Arc::new(Mailbox {
            pending: Mutex::new(Pending {
                request: Some(Request::Load),
                ..Default::default()
            }),
            wake: Notify::new(),
        });
        let (sender, reply) = watch::channel(None);
        ticket.start();
        let owned = mailbox.clone();
        scope.scheduler.clone().spawn(async move {
            let result = run(store, scope, policy, budget, owned, sender).await;
            ticket.complete(result);
        });
        Ok(Self { mailbox, reply })
    }
    pub fn poll(&mut self) -> Option<Reply> {
        self.reply.has_changed().ok().filter(|changed| *changed)?;
        self.reply.borrow_and_update().clone()
    }
    pub fn load(&self) {
        self.mailbox.pending.lock().unwrap().request = Some(Request::Load);
        self.mailbox.wake.notify_one();
    }
    pub fn save(&self, save: Save) {
        let mut pending = self.mailbox.pending.lock().unwrap();
        pending.request = Some(Request::Save(Box::new(save)));
        pending.unsaved = None;
        drop(pending);
        self.mailbox.wake.notify_one();
    }
    pub fn unsaved(&self, diagnostic: String) {
        self.mailbox.pending.lock().unwrap().unsaved = Some(diagnostic);
    }
    pub fn close(self) {
        self.mailbox.pending.lock().unwrap().closed = true;
        self.mailbox.wake.notify_one();
    }
}
fn diagnostic(error: impl std::fmt::Display) -> String {
    error.to_string().chars().take(1024).collect()
}
async fn run(
    store: Arc<RootStore>,
    scope: Scope,
    policy: EditorPersistence,
    budget: NativeBudget,
    mailbox: Arc<Mailbox>,
    reply: watch::Sender<Option<Reply>>,
) -> Result<(), String> {
    let mut checkpoints = None;
    let mut loaded = false;
    let mut revision = None;
    let mut failed_save = None;
    loop {
        let notified = mailbox.wake.notified();
        let request = {
            let mut pending = mailbox.pending.lock().unwrap();
            if let Some(request) = pending.request.take() {
                Some(request)
            } else if pending.closed {
                return pending.unsaved.take().or(failed_save).map_or(Ok(()), Err);
            } else {
                None
            }
        };
        let Some(request) = request else {
            notified.await;
            continue;
        };
        match request {
            Request::Load => {
                let result = async {
                    if checkpoints.is_none() {
                        checkpoints = Some(scope.open(&store).map_err(diagnostic)?);
                    }
                    let admission_budget = budget.clone();
                    let record = checkpoints
                        .as_ref()
                        .unwrap()
                        .read(&policy.key, move |size| {
                            admission_budget
                                .reserve(Kind::Encoded, size)
                                .map(|permit| (permit, size))
                                .map_err(|error| {
                                    maka_event_log::StoreError::InvalidTransition(error.to_string())
                                })
                        })
                        .await
                        .map_err(diagnostic)?;
                    let Some((record, (mut memory, admitted))) = record else {
                        return Ok(None);
                    };
                    if record.format != policy.stored_format()
                        || record.data_source != policy.data_source
                    {
                        return Err(
                            "saved editor format or business data source does not match".into()
                        );
                    }
                    let saved: Saved =
                        serde_json::from_value(record.metadata).map_err(diagnostic)?;
                    let text = String::from_utf8(record.content).map_err(diagnostic)?;
                    let snapshot = &saved.snapshot;
                    if snapshot.text.owner.is_empty()
                        || snapshot.text.bytes != text.len()
                        || snapshot.text.revision > (1 << 53) - 1
                        || snapshot.marked.is_some()
                        || snapshot.selection.start > snapshot.selection.end
                        || snapshot.selection.end > text.encode_utf16().count()
                    {
                        return Err("saved native editor observation is invalid".into());
                    }
                    let retained = text
                        .len()
                        .checked_add(
                            maka_plugin_core::json::encoded_size(&saved, usize::MAX)
                                .map_err(diagnostic)?,
                        )
                        .ok_or("editor checkpoint size overflow")?;
                    let extra = if retained > admitted {
                        Some(
                            budget
                                .reserve(Kind::Encoded, retained - admitted)
                                .map_err(diagnostic)?,
                        )
                    } else {
                        memory.shrink_to(retained);
                        None
                    };
                    Ok::<_, String>(Some(Arc::new(Loaded {
                        version: record.revision,
                        saved,
                        text,
                        _memory: (memory, extra),
                    })))
                }
                .await;
                match result {
                    Ok(value) => {
                        revision = value.as_ref().map(|record| record.version);
                        loaded = true;
                        reply.send_replace(Some(Reply::Loaded(value)));
                    }
                    Err(error) => {
                        loaded = false;
                        reply.send_replace(Some(Reply::Failed {
                            writing: false,
                            diagnostic: error,
                        }));
                    }
                }
            }
            Request::Save(save) => {
                let save = *save;
                let result = async {
                    if !loaded {
                        return Err("original editor checkpoint has not been loaded".into());
                    }
                    checkpoints
                        .as_ref()
                        .unwrap()
                        .write(
                            &policy.key,
                            revision,
                            &policy.stored_format(),
                            &policy.data_source,
                            &serde_json::to_value(&save.saved).map_err(diagnostic)?,
                            save.text,
                        )
                        .await
                        .map_err(diagnostic)
                }
                .await;
                match result {
                    Ok(next) => {
                        revision = Some(next);
                        failed_save = None;
                        reply.send_replace(Some(Reply::Saved(save.sequence)));
                    }
                    Err(error) => {
                        failed_save = Some(error.clone());
                        reply.send_replace(Some(Reply::Failed {
                            writing: true,
                            diagnostic: error,
                        }));
                    }
                }
            }
        }
    }
}

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

//! Ephemeral authentication owned by the public page changes stream.
use super::sign_in::Checked;
use super::*;
use maka_plugins::remote::{Stream, StreamProvider};
use std::sync::Mutex;
use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

type Owner = (Uuid, Uuid);
#[derive(Clone, Default)]
pub(super) struct Pages(Arc<Mutex<BTreeMap<Owner, Arc<Page>>>>);
struct Page {
    state: watch::Sender<Option<Attempt>>,
    commands: mpsc::Sender<Attempt>,
    checked: Mutex<Option<Checked>>,
}
#[derive(Clone)]
pub(super) struct Attempt {
    pub id: Uuid,
    pub agent: String,
    pub method: String,
    pub revision: u64,
    pub phase: Phase,
    pub url: Option<String>,
    pub url_revision: u64,
    stop: CancellationToken,
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Phase {
    Pending,
    Cancelling,
    Authenticated,
    Cancelled,
    Failed,
}
impl Attempt {
    pub fn active(&self) -> bool {
        matches!(self.phase, Phase::Pending | Phase::Cancelling)
    }
}
impl Pages {
    fn page(&self, caller: &Caller) -> Option<Arc<Page>> {
        self.0
            .lock()
            .unwrap()
            .get(&(caller.connection_id, caller.document_id))
            .cloned()
    }
    pub fn remember(&self, caller: &Caller, checked: Checked) -> bool {
        let Some(page) = self.page(caller) else {
            return false;
        };
        *page.checked.lock().unwrap() = Some(checked);
        true
    }
    pub fn connected(&self, caller: &Caller) -> bool {
        self.page(caller).is_some()
    }
    pub fn checked(&self, caller: &Caller) -> Option<Checked> {
        self.page(caller)?.checked.lock().unwrap().clone()
    }
    pub fn method_page(&self, caller: &Caller, id: Uuid, start: usize) -> Result<(), Error> {
        let page = self.page(caller).ok_or(Error::Cancelled)?;
        let mut checked = page.checked.lock().unwrap();
        let checked = checked
            .as_mut()
            .filter(|checked| checked.id == id)
            .ok_or(Error::Cancelled)?;
        checked.start = start;
        Ok(())
    }
    pub fn snapshot(&self, caller: &Caller) -> Option<Attempt> {
        self.page(caller)?.state.borrow().clone()
    }
    pub fn begin(
        &self,
        caller: &Caller,
        agent: String,
        method: String,
        revision: u64,
    ) -> Result<Uuid, Error> {
        let pages = self.0.lock().unwrap();
        let page = pages
            .get(&(caller.connection_id, caller.document_id))
            .ok_or_else(|| Error::Invalid("The sign-in page is not connected; reopen it".into()))?;
        if page.state.borrow().as_ref().is_some_and(Attempt::active) {
            return Err(Error::Invalid("Sign-in is already in progress".into()));
        }
        let attempt = Attempt {
            id: Uuid::new_v4(),
            agent,
            method,
            revision,
            phase: Phase::Pending,
            url: None,
            url_revision: 0,
            stop: CancellationToken::new(),
        };
        let permit = page.commands.try_reserve().map_err(|_| Error::Retired)?;
        let id = attempt.id;
        page.state.send_replace(Some(attempt.clone()));
        permit.send(attempt);
        Ok(id)
    }
    pub fn cancel(&self, caller: &Caller, id: Uuid) -> Result<(), Error> {
        let attempt = self
            .snapshot(caller)
            .filter(|value| value.id == id)
            .ok_or_else(|| Error::Invalid("This sign-in is no longer active".into()))?;
        attempt.stop.cancel();
        Ok(())
    }
    pub fn provider(&self, setup: Arc<crate::setup::Provider>) -> Arc<dyn StreamProvider> {
        Arc::new(Changes {
            pages: self.clone(),
            setup,
        })
    }
}
struct Changes {
    pages: Pages,
    setup: Arc<crate::setup::Provider>,
}
impl StreamProvider for Changes {
    fn open(
        &self,
        input: Value,
        caller: Caller,
    ) -> BoxFuture<'static, Result<Box<dyn Stream>, Error>> {
        let pages = self.pages.clone();
        let setup = self.setup.clone();
        Box::pin(async move {
            if !input.is_null() {
                return Err(Error::Invalid("Changes take no arguments".into()));
            }
            let owner = (caller.connection_id, caller.document_id);
            let stop = caller.cancellation.child_token();
            let (state, receive) = watch::channel(None);
            let (commands, mut requests) = mpsc::channel::<Attempt>(1);
            let page = Arc::new(Page {
                state,
                commands,
                checked: Mutex::new(None),
            });
            let mut entries = pages.0.lock().unwrap();
            if entries.contains_key(&owner) {
                return Err(Error::Invalid("Page already observed".into()));
            }
            let worker_page = page.clone();
            let worker_stop = stop.clone();
            let provider = setup.clone();
            let done = setup.context.spawn_resource("external agent sign-in page", move |stopping| async move {
                loop {
                    let attempt = tokio::select! {
                        biased;
                        _ = worker_stop.cancelled() => break,
                        _ = stopping.cancelled() => break,
                        attempt = requests.recv() => match attempt { Some(value) => value, None => break },
                    };
                    let result = authenticate(&provider, &caller, &worker_page.state, &attempt, &worker_stop, &stopping).await;
                    if matches!(result, Err(Error::CleanupUnconfirmed)) {
                        return Err("External agent sign-in cleanup is unconfirmed".into());
                    }
                }
                Ok(())
            }).map_err(|_| Error::Retired)?;
            entries.insert(owner, page.clone());
            drop(entries);
            Ok(Box::new(Watching {
                pages,
                owner,
                page,
                receive: tokio::sync::Mutex::new(receive),
                stop,
                done,
            }) as Box<dyn Stream>)
        })
    }
}
struct Watching {
    pages: Pages,
    owner: Owner,
    page: Arc<Page>,
    receive: tokio::sync::Mutex<watch::Receiver<Option<Attempt>>>,
    stop: CancellationToken,
    done: oneshot::Receiver<Result<(), String>>,
}
impl Stream for Watching {
    fn next(&self) -> BoxFuture<'_, Result<Option<Value>, Error>> {
        Box::pin(async move {
            let mut receive = self.receive.lock().await;
            tokio::select! {
                biased;
                _ = self.stop.cancelled() => Ok(None),
                value = receive.changed() => { value.map_err(|_| Error::Retired)?; Ok(Some(Value::Null)) }
            }
        })
    }
    fn cancel(&self) {
        self.stop.cancel();
    }
    fn close(self: Box<Self>) -> BoxFuture<'static, Result<(), Error>> {
        self.stop.cancel();
        let mut entries = self.pages.0.lock().unwrap();
        if entries
            .get(&self.owner)
            .is_some_and(|page| Arc::ptr_eq(page, &self.page))
        {
            entries.remove(&self.owner);
        }
        drop(entries);
        Box::pin(async move {
            match tokio::time::timeout(Duration::from_secs(6), self.done).await {
                Ok(Ok(Ok(()))) => Ok(()),
                _ => Err(Error::CleanupUnconfirmed),
            }
        })
    }
}
fn update(state: &watch::Sender<Option<Attempt>>, id: Uuid, change: impl FnOnce(&mut Attempt)) {
    state.send_if_modified(|value| {
        if let Some(value) = value.as_mut().filter(|value| value.id == id) {
            change(value);
            true
        } else {
            false
        }
    });
}
async fn authenticate(
    setup: &crate::setup::Provider,
    caller: &Caller,
    state: &watch::Sender<Option<Attempt>>,
    attempt: &Attempt,
    stop: &CancellationToken,
    stopping: &CancellationToken,
) -> Result<(), Error> {
    let stream = setup
        .open(
            json!({"kind":"authenticate", "agentId":attempt.agent,
        "methodId":attempt.method, "operationId":attempt.id, "expectedRevision":attempt.revision}),
            caller.clone(),
        )
        .await;
    let stream = match stream {
        Ok(stream) => stream,
        Err(error) => {
            update(state, attempt.id, |value| value.phase = Phase::Failed);
            return Err(error);
        }
    };
    let result = tokio::select! {
        biased;
        _ = stop.cancelled() => Err(Error::Cancelled),
        _ = stopping.cancelled() => Err(Error::Cancelled),
        _ = attempt.stop.cancelled() => Err(Error::Cancelled),
        result = async {
            let mut authenticated = false;
            while let Some(event) = stream.next().await? {
                match event["kind"].as_str() {
                    Some("authorization_url") => update(state, attempt.id, |value| {
                        value.url = event["url"].as_str().map(str::to_owned);
                        value.url_revision += 1;
                    }),
                    Some("authenticated") => authenticated = true,
                    _ => {},
                }
            }
            if authenticated { Ok(()) } else { Err(Error::Provider("Sign-in ended without confirmation".into())) }
        } => result,
    };
    if matches!(result, Err(Error::Cancelled)) {
        update(state, attempt.id, |value| {
            value.phase = Phase::Cancelling;
            value.url = None;
        });
    }
    stream.cancel();
    let cleanup = stream.close().await;
    update(state, attempt.id, |value| {
        value.url = None;
        value.phase = match (&cleanup, &result) {
            (Ok(()), Ok(())) => Phase::Authenticated,
            (Ok(()), Err(Error::Cancelled)) => Phase::Cancelled,
            _ => Phase::Failed,
        };
    });
    cleanup.and(result)
}

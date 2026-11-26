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

use super::{Active, Session};
use agent_client_protocol::{Error, Result, v2::schema::IdempotencyKey};
use futures_util::{FutureExt, future::BoxFuture};
use std::{
    collections::HashMap,
    sync::{Arc, atomic::Ordering},
};
use tokio::sync::{OwnedMutexGuard, watch};
use tokio_util::sync::CancellationToken;

type Outcome = Result<String>;
type ResultSender = watch::Sender<Option<Outcome>>;

#[derive(Default)]
pub(super) struct Pending {
    epoch: Option<CancellationToken>,
    keys: HashMap<IdempotencyKey, (CancellationToken, ResultSender)>,
}

impl Pending {
    pub(super) fn child_token(&mut self, parent: &CancellationToken) -> CancellationToken {
        self.epoch
            .get_or_insert_with(|| parent.child_token())
            .child_token()
    }

    pub(super) fn cancel(&mut self) {
        if let Some(epoch) = self.epoch.take() {
            epoch.cancel();
        }
    }
}

pub(crate) enum Registration {
    First(Leader),
    Retry(Retry),
}

pub(crate) struct Retry(watch::Receiver<Option<Outcome>>);

impl Retry {
    async fn settled(&mut self) -> Result<watch::Ref<'_, Option<Outcome>>> {
        self.0
            .wait_for(Option::is_some)
            .await
            .map_err(|_| Error::internal_error().data("ACP prompt admission task stopped"))
    }

    pub async fn wait(mut self) -> Outcome {
        self.settled().await?.as_ref().unwrap().clone()
    }
}

pub(crate) struct Leader {
    session: Arc<Session>,
    pub cancel: CancellationToken,
    gate: BoxFuture<'static, OwnedMutexGuard<()>>,
    predecessor: Option<Retry>,
    keyed: Option<(IdempotencyKey, ResultSender)>,
}

impl Session {
    pub fn prompt(
        self: &Arc<Self>,
        key: Option<&IdempotencyKey>,
        parent: &CancellationToken,
    ) -> Result<Registration> {
        let mut pending = self.prompts.lock().unwrap();
        if self.closed.load(Ordering::SeqCst) || parent.is_cancelled() {
            return Err(Error::invalid_params().data("ACP session is closed"));
        }
        let predecessor = match key.and_then(|k| pending.keys.get(k)) {
            Some((cancel, result)) if !cancel.is_cancelled() => {
                return Ok(Registration::Retry(Retry(result.subscribe())));
            }
            Some((_, result)) => Some(Retry(result.subscribe())),
            None => None,
        };
        let cancel = pending.child_token(parent);
        let keyed = key.map(|key| {
            let (result, _) = watch::channel(None);
            pending
                .keys
                .insert(key.clone(), (cancel.clone(), result.clone()));
            (key.clone(), result)
        });

        // Tokio enqueues a mutex waiter on first poll, not when constructing
        // the future. Reserve our FIFO position before the async Host lookup.
        let mut gate = self.gate.clone().lock_owned().boxed();
        if let Some(guard) = tokio::task::unconstrained(gate.as_mut()).now_or_never() {
            gate = std::future::ready(guard).boxed();
        }
        Ok(Registration::First(Leader {
            session: self.clone(),
            cancel,
            gate,
            predecessor,
            keyed,
        }))
    }
}

impl Leader {
    // A cancel notification marks the epoch, not the Host withdrawal commit.
    // Only a new leader for that same key needs the old decision before lookup.
    pub async fn settle_predecessor(&mut self) -> Result<()> {
        if let Some(mut previous) = self.predecessor.take() {
            drop(previous.settled().await?);
        }
        Ok(())
    }

    pub async fn enter(&mut self) -> Result<Active> {
        let guard = tokio::select! {
            biased;
            _ = self.cancel.cancelled() => return Err(Error::request_cancelled()),
            guard = &mut self.gate => guard,
        };
        if self.cancel.is_cancelled() || self.session.closed.load(Ordering::SeqCst) {
            return Err(Error::request_cancelled());
        }
        Ok(Active {
            cancel: self.cancel.clone(),
            _guard: guard,
        })
    }

    pub fn publish(self, result: Outcome) -> Outcome {
        if let Some((_, sender)) = &self.keyed {
            sender.send_replace(Some(result.clone()));
        }
        result
    }
}

impl Drop for Leader {
    fn drop(&mut self) {
        if let Some((key, sender)) = &self.keyed {
            let mut pending = self.session.prompts.lock().unwrap();
            if pending
                .keys
                .get(key)
                .is_some_and(|(_, current)| current.same_channel(sender))
            {
                pending.keys.remove(key);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn held_prompts_enter_in_receive_order_even_when_later_lookup_finishes_first() {
        let session = Session::new("session".into());
        let stop = CancellationToken::new();
        let running = session.enter(&stop).unwrap();
        let register = || match session.prompt(None, &stop).unwrap() {
            Registration::First(leader) => leader,
            Registration::Retry(_) => panic!("unkeyed prompts cannot join a submission"),
        };
        let mut first = register();
        let mut second = register();
        drop(running);
        // The second Host lookup finishes before the first.
        assert!(second.enter().now_or_never().is_none());
        let active = first.enter().await.unwrap();
        drop(active);
        let _next = second.enter().await.unwrap();
    }
}

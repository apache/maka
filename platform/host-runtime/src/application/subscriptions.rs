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
use tokio_util::sync::DropGuard;

const ITEMS: usize = 16;

/// A request-local reader. Demand cancellation and executor cleanup are distinct.
/// Read through EOF to drain successful output; completion cancels undrained work.
pub struct Subscription {
    accepted: Accepted,
    items: Items,
}
/// Shared bounded queue mechanics, independent of query or mutation settlement.
pub(super) struct Items {
    receiver: mpsc::Receiver<Value>,
    shared: Arc<Shared>,
    _cancel_on_drop: DropGuard,
}
impl Subscription {
    pub fn id(&self) -> Uuid {
        self.accepted.id
    }

    /// Receive ordered items. Producer completion permits draining already
    /// accepted items even if a native handler retained an old Context/future.
    pub async fn recv(&mut self) -> Option<Value> {
        self.items.recv().await
    }

    /// Requests stop and closes demand. It does not acknowledge executor cleanup.
    pub fn cancel(&mut self) {
        self.items.cancel();
    }

    /// Close demand before awaiting the original owner's independent business
    /// and cleanup observations, so undrained backpressure cannot deadlock it.
    pub async fn completion(mut self) -> QueryCompletion {
        self.cancel();
        while self.items.receiver.try_recv().is_ok() {}
        self.accepted.completion().await
    }
}
impl Items {
    pub(super) async fn recv(&mut self) -> Option<Value> {
        if let Ok(value) = self.receiver.try_recv() {
            return Some(value);
        }
        if self.shared.closed.is_cancelled() {
            return None;
        }
        tokio::select! {
            biased;
            value = self.receiver.recv() => value,
            () = self.shared.closed.cancelled() => self.receiver.try_recv().ok(),
        }
    }

    fn cancel(&mut self) {
        self.shared.stop.cancel();
        self.receiver.close();
    }
}

struct Shared {
    // Only producer close and synchronous queue insertion take this gate.
    sender: Mutex<Option<mpsc::Sender<Value>>>,
    closed: CancellationToken,
    stop: CancellationToken,
    output: Arc<jsonschema::Validator>,
}
#[derive(Clone)]
pub(super) struct Emitter(Arc<Shared>);
impl Emitter {
    pub(super) fn close(&self) {
        let mut sender = self.0.sender.lock().expect("subscription gate poisoned");
        self.0.closed.cancel();
        sender.take();
    }

    pub(super) fn emit(&self, value: Value) -> BoxFuture<'static, Result<()>> {
        if self.0.closed.is_cancelled() || self.0.stop.is_cancelled() {
            return Box::pin(async { Err("Host subscription is closed".into()) });
        }
        if let Err(error) = self.0.output.validate(&value) {
            let error = error.to_string();
            return Box::pin(async move { Err(error) });
        }
        let shared = self.0.clone();
        Box::pin(async move {
            // Do not give an unpolled future a sender that could keep EOF open.
            let sender = shared
                .sender
                .lock()
                .expect("subscription gate poisoned")
                .as_ref()
                .cloned()
                .ok_or("Host subscription is closed")?;
            let capacity = tokio::select! {
                biased;
                () = shared.stop.cancelled() => return Err("Host subscription was cancelled".into()),
                () = shared.closed.cancelled() => return Err("Host subscription is closed".into()),
                capacity = sender.reserve_owned() => capacity.map_err(|_| "Host subscription reader is closed".to_string())?,
            };
            let gate = shared.sender.lock().expect("subscription gate poisoned");
            if gate.is_none() || shared.stop.is_cancelled() {
                return Err("Host subscription is closed".into());
            }
            // Linearize insertion with producer close; no item can follow EOF.
            capacity.send(value);
            Ok(())
        })
    }
}

pub(super) fn channel(
    accepted: Accepted,
    output: Arc<jsonschema::Validator>,
    stop: CancellationToken,
) -> (Subscription, Emitter) {
    let (items, emitter) = items(output, stop);
    (Subscription { accepted, items }, emitter)
}

/// The caller chooses the cancellation boundary. Mutation demand uses a child
/// token, so dropping its reader never cancels the original execution Scope.
pub(super) fn items(
    output: Arc<jsonschema::Validator>,
    stop: CancellationToken,
) -> (Items, Emitter) {
    let (sender, receiver) = mpsc::channel(ITEMS);
    let guard = stop.clone().drop_guard();
    let shared = Arc::new(Shared {
        sender: Mutex::new(Some(sender)),
        closed: CancellationToken::new(),
        stop,
        output,
    });
    (
        Items {
            receiver,
            shared: shared.clone(),
            _cancel_on_drop: guard,
        },
        Emitter(shared),
    )
}

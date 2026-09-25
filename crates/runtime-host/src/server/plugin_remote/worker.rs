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

use super::registry::Reservation;
use crate::plugins::remote::Bound;
use futures_util::FutureExt;
use maka_plugins::remote::{Caller, Error, StreamProvider, validate_payload};
use serde_json::Value;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub(super) struct Handle {
    reads: mpsc::Sender<Read>,
    pending: Arc<AtomicBool>,
    stop: CancellationToken,
    done: watch::Receiver<Option<Result<(), Error>>>,
}
struct Read {
    reply: Option<oneshot::Sender<Result<Item, Error>>>,
    pending: Arc<AtomicBool>,
}
pub(super) enum Item {
    Value(Value),
    End,
    Pending,
}
impl Drop for Read {
    fn drop(&mut self) {
        self.pending.store(false, Ordering::Release);
    }
}
impl Handle {
    pub async fn next(&self) -> Result<Item, Error> {
        if self
            .pending
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(Error::Invalid(
                "Only one Remote stream read may be pending".into(),
            ));
        }
        let (reply, result) = oneshot::channel();
        let read = Read {
            reply: Some(reply),
            pending: self.pending.clone(),
        };
        self.reads.try_send(read).map_err(|_| Error::Retired)?;
        result.await.map_err(|_| Error::Retired)?
    }
    pub async fn close(&self) -> Result<(), Error> {
        self.stop.cancel();
        let mut done = self.done.clone();
        loop {
            if let Some(result) = done.borrow_and_update().clone() {
                return result;
            }
            done.changed()
                .await
                .map_err(|_| Error::CleanupUnconfirmed)?;
        }
    }
}

pub(super) fn start(
    mut reservation: Reservation,
    bound: Bound,
    provider: Arc<dyn StreamProvider>,
    input: Value,
    caller: Caller,
    tasks: &tokio_util::task::TaskTracker,
) -> Result<(Uuid, oneshot::Receiver<Result<(), Error>>), maka_protocol::OperationError> {
    let leases = bound.admit()?;
    let id = Uuid::new_v4();
    let stop = caller.cancellation.clone();
    let resources = caller.resources.clone();
    let (reads, receiver) = mpsc::channel(1);
    let (done, completed) = watch::channel(None);
    let (ready, opened) = oneshot::channel();
    let handle = Arc::new(Handle {
        reads,
        pending: Arc::new(AtomicBool::new(false)),
        stop: stop.clone(),
        done: completed,
    });
    reservation.document.insert(id, handle)?;
    tasks.spawn(async move {
        let _leases = leases;
        let mut result = std::panic::AssertUnwindSafe(run(
            &mut reservation,
            &bound,
            provider,
            input,
            caller,
            receiver,
            ready,
        ))
        .catch_unwind()
        .await
        .unwrap_or(Err(Error::CleanupUnconfirmed));
        stop.cancel();
        if resources.finish().await.is_err() {
            result = Err(Error::CleanupUnconfirmed);
        }
        if matches!(result, Err(Error::CleanupUnconfirmed)) {
            reservation.document.cleanup_failed();
            bound
                .endpoint
                .owner
                .cleanup_failed("Remote stream cleanup is unconfirmed".into());
        }
        done.send_replace(Some(result));
        reservation.document.forget(id);
        stop.cancel();
        drop(reservation);
    });
    Ok((id, opened))
}

async fn run(
    reservation: &mut Reservation,
    bound: &Bound,
    provider: Arc<dyn StreamProvider>,
    input: Value,
    caller: Caller,
    mut reads: mpsc::Receiver<Read>,
    ready: oneshot::Sender<Result<(), Error>>,
) -> Result<(), Error> {
    let stop = caller.cancellation.clone();
    let mut opening = provider.open(input, caller);
    let opened = tokio::select! {
        biased;
        _ = stop.cancelled() => None,
        _ = bound.retired() => None,
        _ = tokio::time::sleep(std::time::Duration::from_secs(30)) => None,
        result = &mut opening => Some(result),
    };
    let stream = match opened {
        Some(Ok(stream)) => stream,
        Some(Err(error)) => {
            let uncertain = matches!(error, Error::CleanupUnconfirmed);
            let _ = ready.send(Err(error));
            return if uncertain {
                Err(Error::CleanupUnconfirmed)
            } else {
                Ok(())
            };
        }
        None => {
            stop.cancel();
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
            let _ = ready.send(Err(Error::Cancelled));
            let late = tokio::time::timeout_at(deadline, opening)
                .await
                .map_err(|_| Error::CleanupUnconfirmed)?;
            if let Ok(stream) = late {
                stream.cancel();
                return match tokio::time::timeout_at(deadline, stream.close()).await {
                    Ok(Ok(())) => Ok(()),
                    _ => Err(Error::CleanupUnconfirmed),
                };
            }
            return match late {
                Err(Error::CleanupUnconfirmed) => Err(Error::CleanupUnconfirmed),
                _ => Ok(()),
            };
        }
    };
    drop(opening);
    reservation.release_work();
    let visible = ready.send(Ok(())).is_ok();
    let mut terminal = None;
    // Keep the provider future across bounded polls: timing out a transport
    // request must not cancel a read that may already have consumed an item.
    let mut current = None;
    if visible {
        loop {
            let request = tokio::select! {
                biased;
                _ = stop.cancelled() => break,
                _ = bound.retired() => break,
                read = reads.recv() => match read { Some(read) => read, None => break },
            };
            if request
                .reply
                .as_ref()
                .is_none_or(oneshot::Sender::is_closed)
            {
                continue;
            }
            let next = current.get_or_insert_with(|| stream.next());
            let result = tokio::select! {
                biased;
                _ = stop.cancelled() => Err(Error::Cancelled),
                _ = bound.retired() => Err(Error::Retired),
                _ = tokio::time::sleep(std::time::Duration::from_secs(10)) => Ok(Item::Pending),
                result = next => result.and_then(|item| {
                    if let Some(value) = &item { validate_payload(value)?; }
                    Ok(item.map_or(Item::End, Item::Value))
                }),
            };
            if matches!(result, Ok(Item::Value(_))) {
                current = None;
            }
            if matches!(result, Ok(Item::Value(_) | Item::Pending)) {
                request.send(result);
            } else {
                terminal = Some((request, result));
                break;
            }
        }
    }
    stop.cancel();
    stream.cancel();
    drop(current);
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    let cleanup = match tokio::time::timeout_at(deadline, stream.close()).await {
        Ok(Ok(())) => Ok(()),
        _ => Err(Error::CleanupUnconfirmed),
    };
    if let Some((request, result)) = terminal {
        request.send(match &cleanup {
            Ok(()) => result,
            Err(_) => Err(Error::CleanupUnconfirmed),
        });
    }
    cleanup
}
impl Read {
    fn send(mut self, result: Result<Item, Error>) {
        let reply = self.reply.take().expect("Remote read has one reply");
        drop(self);
        let _ = reply.send(result);
    }
}

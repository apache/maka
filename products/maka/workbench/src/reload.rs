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

use nsh_core::JsonValue;
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, oneshot};

#[derive(Debug)]
pub enum Request {
    Pause(oneshot::Sender<Result<(), String>>),
    Resume,
    Reload,
}

/// One shell owns the requests; its admitted Host and journal survive reloads.
#[derive(Clone)]
pub struct UiReload(Arc<State>);

struct State {
    sender: mpsc::UnboundedSender<Request>,
    receiver: Mutex<Option<mpsc::UnboundedReceiver<Request>>>,
    restored: Mutex<JsonValue>,
    pause: Mutex<PauseAdmission>,
}

#[derive(Default)]
enum PauseAdmission {
    #[default]
    Available,
    Requested,
    Held,
    ReloadQueued,
}

struct PauseAttempt<'scope> {
    owner: Option<&'scope State>,
}

struct Reload {
    owner: UiReload,
    state: JsonValue,
}

#[must_use]
pub(crate) struct PendingReload(Option<Reload>);

impl State {
    fn resume(&self, admission: &mut PauseAdmission) -> Result<(), String> {
        let result = self
            .sender
            .send(Request::Resume)
            .map_err(|_| "the native UI is closed".into());
        // The ordered command owns resumption before a replacement Pause can enter.
        *admission = PauseAdmission::Available;
        result
    }

    fn cancel(&self) -> Result<(), String> {
        self.resume(&mut self.pause.lock().unwrap())
    }
}

impl PauseAttempt<'_> {
    fn hold(mut self) {
        let owner = self
            .owner
            .expect("the original pause attempt still owns cleanup");
        let mut admission = owner.pause.lock().unwrap();
        *admission = PauseAdmission::Held;
        self.owner = None;
    }

    fn cancel(mut self) -> Result<(), String> {
        self.owner
            .take()
            .expect("the original pause attempt still owns cleanup")
            .cancel()
    }
}

impl Drop for PauseAttempt<'_> {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.take()
            && let Err(error) = owner.cancel()
        {
            eprintln!("maka-workbench: could not resume cancelled UI pause: {error}");
        }
    }
}

impl PendingReload {
    pub(crate) fn enqueue(mut self) -> Result<(), String> {
        let Reload { owner, state } = self.0.take().expect("reload is queued once");
        let mut admission = owner.0.pause.lock().unwrap();
        let mut restored = owner.0.restored.lock().unwrap();
        let previous = std::mem::replace(&mut *restored, state);
        if owner.0.sender.send(Request::Reload).is_err() {
            *restored = previous;
            let error = "the native UI closed before reload was queued";
            return match owner.0.resume(&mut admission) {
                Ok(()) => Err(error.into()),
                Err(cleanup) => Err(format!("{error}; could not resume UI input: {cleanup}")),
            };
        }
        *admission = PauseAdmission::Available;
        Ok(())
    }
}

impl Drop for PendingReload {
    fn drop(&mut self) {
        if let Some(reload) = self.0.take()
            && let Err(error) = reload.owner.0.cancel()
        {
            eprintln!("maka-workbench: could not resume abandoned UI reload: {error}");
        }
    }
}

impl Default for UiReload {
    fn default() -> Self {
        let (sender, receiver) = mpsc::unbounded_channel();
        Self(Arc::new(State {
            sender,
            receiver: Mutex::new(Some(receiver)),
            restored: Mutex::new(JsonValue::Null),
            pause: Mutex::default(),
        }))
    }
}

impl UiReload {
    pub fn take_requests(&self) -> mpsc::UnboundedReceiver<Request> {
        self.0
            .receiver
            .lock()
            .unwrap()
            .take()
            .expect("one native shell owns its UI reload requests")
    }

    pub(crate) async fn pause(&self) -> Result<(), String> {
        let (ready, received) = oneshot::channel();
        let attempt = {
            let mut admission = self.0.pause.lock().unwrap();
            if !matches!(*admission, PauseAdmission::Available) {
                return Err("UI input pause is already owned".into());
            }
            self.0
                .sender
                .send(Request::Pause(ready))
                .map_err(|_| "the native UI is closed")?;
            *admission = PauseAdmission::Requested;
            PauseAttempt {
                owner: Some(&self.0),
            }
        };
        let result = match received.await {
            Ok(result) => result,
            Err(_) => Err("the native UI closed before input was paused".into()),
        };
        match result {
            Ok(()) => {
                attempt.hold();
                Ok(())
            }
            Err(error) => match attempt.cancel() {
                Ok(()) => Err(error),
                Err(cleanup) => Err(format!("{error}; could not resume UI input: {cleanup}")),
            },
        }
    }

    pub(crate) fn resume(&self) -> Result<(), String> {
        let mut admission = self.0.pause.lock().unwrap();
        match *admission {
            PauseAdmission::Available => Ok(()),
            PauseAdmission::Held => self.0.resume(&mut admission),
            PauseAdmission::Requested | PauseAdmission::ReloadQueued => {
                Err("the original UI pause is still in progress".into())
            }
        }
    }

    pub fn restored(&self) -> JsonValue {
        self.0.restored.lock().unwrap().clone()
    }

    /// Remembers presentation state while the native window is closed.
    pub fn remember(&self, state: JsonValue) {
        *self.0.restored.lock().unwrap() = state;
    }

    pub(crate) fn prepare(&self, state: JsonValue) -> Result<PendingReload, String> {
        let mut admission = self.0.pause.lock().unwrap();
        if !matches!(*admission, PauseAdmission::Held) {
            return Err("UI input must be paused before reload".into());
        }
        let pending = PendingReload(Some(Reload {
            owner: self.clone(),
            state,
        }));
        *admission = PauseAdmission::ReloadQueued;
        Ok(pending)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        future::Future,
        pin::Pin,
        task::{Context, Poll, Waker},
    };

    fn poll<F: Future>(future: Pin<&mut F>) -> Poll<F::Output> {
        future.poll(&mut Context::from_waker(Waker::noop()))
    }

    fn pause_command(
        requests: &mut mpsc::UnboundedReceiver<Request>,
    ) -> oneshot::Sender<Result<(), String>> {
        match requests.try_recv().unwrap() {
            Request::Pause(ready) => ready,
            request => panic!("expected original Pause, received {request:?}"),
        }
    }

    fn resume_command(requests: &mut mpsc::UnboundedReceiver<Request>) {
        assert!(matches!(requests.try_recv().unwrap(), Request::Resume));
    }

    fn empty(requests: &mut mpsc::UnboundedReceiver<Request>) {
        assert_eq!(
            requests.try_recv().err(),
            Some(mpsc::error::TryRecvError::Empty)
        );
    }

    #[test]
    fn duplicate_pause_and_early_resume_leave_the_original_owner_intact() {
        let reload = UiReload::default();
        let mut requests = reload.take_requests();
        let mut first = Box::pin(reload.pause());
        assert!(poll(first.as_mut()).is_pending());
        let ready = pause_command(&mut requests);
        let mut duplicate = Box::pin(reload.pause());
        assert_eq!(
            poll(duplicate.as_mut()),
            Poll::Ready(Err("UI input pause is already owned".into()))
        );
        assert_eq!(
            reload.resume(),
            Err("the original UI pause is still in progress".into())
        );
        assert_eq!(
            reload.prepare(json!({"premature": true})).err().as_deref(),
            Some("UI input must be paused before reload")
        );
        empty(&mut requests);
        ready.send(Ok(())).unwrap();
        assert_eq!(poll(first.as_mut()), Poll::Ready(Ok(())));
        drop(first);
        empty(&mut requests);
        let mut duplicate = Box::pin(reload.pause());
        assert_eq!(
            poll(duplicate.as_mut()),
            Poll::Ready(Err("UI input pause is already owned".into()))
        );
        reload.resume().unwrap();
        resume_command(&mut requests);
        reload.resume().unwrap();
        empty(&mut requests);
    }

    #[test]
    fn barrier_failure_returns_its_cause_and_orders_resume_before_replacement_pause() {
        let reload = UiReload::default();
        let mut requests = reload.take_requests();
        let mut first = Box::pin(reload.pause());
        assert!(poll(first.as_mut()).is_pending());
        pause_command(&mut requests)
            .send(Err("pending input has no editable focus target".into()))
            .unwrap();
        assert_eq!(
            poll(first.as_mut()),
            Poll::Ready(Err("pending input has no editable focus target".into()))
        );
        drop(first);
        let mut replacement = Box::pin(reload.pause());
        assert!(poll(replacement.as_mut()).is_pending());
        resume_command(&mut requests);
        pause_command(&mut requests).send(Ok(())).unwrap();
        assert_eq!(poll(replacement.as_mut()), Poll::Ready(Ok(())));
        drop(replacement);
        empty(&mut requests);
        reload.resume().unwrap();
        resume_command(&mut requests);
    }

    #[test]
    fn dropping_an_unaccepted_pause_cannot_resume_its_replacement() {
        for acknowledgement_ready in [false, true] {
            let reload = UiReload::default();
            let mut requests = reload.take_requests();
            let mut first = Box::pin(reload.pause());
            assert!(poll(first.as_mut()).is_pending());
            let ready = pause_command(&mut requests);
            let stale = if acknowledgement_ready {
                ready.send(Ok(())).unwrap();
                None
            } else {
                Some(ready)
            };
            drop(first);
            let mut replacement = Box::pin(reload.pause());
            assert!(poll(replacement.as_mut()).is_pending());
            resume_command(&mut requests);
            let ready = pause_command(&mut requests);
            if let Some(stale) = stale {
                assert_eq!(stale.send(Ok(())), Err(Ok(())));
            }
            ready.send(Ok(())).unwrap();
            assert_eq!(poll(replacement.as_mut()), Poll::Ready(Ok(())));
            drop(replacement);
            empty(&mut requests);
            let mut duplicate = Box::pin(reload.pause());
            assert_eq!(
                poll(duplicate.as_mut()),
                Poll::Ready(Err("UI input pause is already owned".into()))
            );
            reload.resume().unwrap();
            resume_command(&mut requests);
        }
    }

    #[test]
    fn lost_pause_acknowledgement_returns_its_original_cleanup_to_the_queue() {
        let reload = UiReload::default();
        let mut requests = reload.take_requests();
        let mut pause = Box::pin(reload.pause());
        assert!(poll(pause.as_mut()).is_pending());
        drop(pause_command(&mut requests));
        assert_eq!(
            poll(pause.as_mut()),
            Poll::Ready(Err("the native UI closed before input was paused".into()))
        );
        drop(pause);
        resume_command(&mut requests);
        empty(&mut requests);
    }

    #[test]
    fn dropping_an_unpolled_deferred_reload_resumes_without_publishing_its_snapshot() {
        let reload = UiReload::default();
        let mut requests = reload.take_requests();
        let mut pause = Box::pin(reload.pause());
        assert!(poll(pause.as_mut()).is_pending());
        pause_command(&mut requests).send(Ok(())).unwrap();
        assert_eq!(poll(pause.as_mut()), Poll::Ready(Ok(())));
        drop(pause);
        let pending = reload.prepare(json!({"draft": "kept by old VM"})).unwrap();
        assert_eq!(
            reload.resume(),
            Err("the original UI pause is still in progress".into())
        );
        let mut duplicate = Box::pin(reload.pause());
        assert_eq!(
            poll(duplicate.as_mut()),
            Poll::Ready(Err("UI input pause is already owned".into()))
        );
        let deferred = async move { pending.enqueue() };
        empty(&mut requests);
        drop(deferred);
        resume_command(&mut requests);
        assert_eq!(reload.restored(), JsonValue::Null);
        let mut replacement = Box::pin(reload.pause());
        assert!(poll(replacement.as_mut()).is_pending());
        pause_command(&mut requests).send(Ok(())).unwrap();
        assert_eq!(poll(replacement.as_mut()), Poll::Ready(Ok(())));
        drop(replacement);
        empty(&mut requests);
        reload.resume().unwrap();
        resume_command(&mut requests);
    }

    #[test]
    fn reload_snapshot_precedes_its_command_and_the_next_vm_pause() {
        let reload = UiReload::default();
        let mut requests = reload.take_requests();
        assert_eq!(
            reload.prepare(json!({})).err().as_deref(),
            Some("UI input must be paused before reload")
        );
        let mut pause = Box::pin(reload.pause());
        assert!(poll(pause.as_mut()).is_pending());
        pause_command(&mut requests).send(Ok(())).unwrap();
        assert_eq!(poll(pause.as_mut()), Poll::Ready(Ok(())));
        drop(pause);
        let snapshot = json!({"instances": [{"state": {"draft": "原文😀"}}]});
        let pending = reload.prepare(snapshot.clone()).unwrap();
        empty(&mut requests);
        assert_eq!(reload.restored(), JsonValue::Null);
        pending.enqueue().unwrap();
        let mut next_vm = Box::pin(reload.pause());
        assert!(poll(next_vm.as_mut()).is_pending());
        assert!(matches!(requests.try_recv().unwrap(), Request::Reload));
        assert_eq!(reload.restored(), snapshot);
        pause_command(&mut requests).send(Ok(())).unwrap();
        assert_eq!(poll(next_vm.as_mut()), Poll::Ready(Ok(())));
        drop(next_vm);
        empty(&mut requests);
        reload.resume().unwrap();
        resume_command(&mut requests);
    }

    #[test]
    fn a_closed_native_receiver_preserves_errors_without_publishing_a_failed_reload() {
        let reload = UiReload::default();
        let mut requests = reload.take_requests();
        let mut pause = Box::pin(reload.pause());
        assert!(poll(pause.as_mut()).is_pending());
        pause_command(&mut requests).send(Ok(())).unwrap();
        assert_eq!(poll(pause.as_mut()), Poll::Ready(Ok(())));
        drop(pause);
        let pending = reload.prepare(json!({"unpublished": true})).unwrap();
        drop(requests);
        assert_eq!(
            pending.enqueue(),
            Err("the native UI closed before reload was queued; could not resume UI input: the native UI is closed".into())
        );
        assert_eq!(reload.restored(), JsonValue::Null);
        let mut retry = Box::pin(reload.pause());
        assert_eq!(
            poll(retry.as_mut()),
            Poll::Ready(Err("the native UI is closed".into()))
        );
    }

    #[test]
    fn dropping_a_pending_pause_after_native_disconnect_does_not_panic() {
        let reload = UiReload::default();
        let mut requests = reload.take_requests();
        let mut pause = Box::pin(reload.pause());
        assert!(poll(pause.as_mut()).is_pending());
        let ready = pause_command(&mut requests);
        drop(requests);
        drop(pause);
        assert_eq!(ready.send(Ok(())), Err(Ok(())));
        let mut retry = Box::pin(reload.pause());
        assert_eq!(
            poll(retry.as_mut()),
            Poll::Ready(Err("the native UI is closed".into()))
        );
    }
}

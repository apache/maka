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

//! Protocol fixtures, not desktop or browser integration evidence.

use super::*;
use std::{sync::atomic::AtomicUsize, task::Poll};
use tokio::sync::oneshot;

fn main() -> DialogTarget {
    DialogTarget { session: None }
}

fn child(id: &str) -> DialogTarget {
    DialogTarget {
        session: Some(id.into()),
    }
}

fn open(dialogs: &Dialogs, target: DialogTarget, kind: DialogType) -> ActiveDialog {
    dialogs
        .observe(DialogEvent::Opening {
            target,
            kind,
            message: "Fixture message".into(),
            default_prompt: "Default response".into(),
            url: "https://fixture.example/".into(),
        })
        .unwrap();
    dialogs.current().unwrap()
}

#[test]
fn dialog_objects_and_exact_parameter_mapping() {
    let dialogs = Dialogs::default();
    assert!(dialogs.current().is_none());
    for kind in [
        DialogType::Alert,
        DialogType::BeforeUnload,
        DialogType::Confirm,
        DialogType::Prompt,
    ] {
        let dialog = open(&dialogs, main(), kind);
        let id = &dialog.metadata.id;
        let dismiss = dialogs
            .prepare_handle(id, DialogAction::Dismiss, Some("ignored".into()))
            .unwrap();
        assert_eq!(
            dismiss.request,
            DialogRequest {
                target: main(),
                accept: kind == DialogType::Alert,
                prompt_text: None,
            }
        );
        if matches!(kind, DialogType::Alert | DialogType::BeforeUnload) {
            assert!(
                dialogs
                    .prepare_handle(id, DialogAction::Accept, None)
                    .is_err()
            );
        }
        if kind == DialogType::Confirm {
            assert!(
                dialogs
                    .prepare_handle(id, DialogAction::Accept, Some(String::new()))
                    .is_err()
            );
            assert!(
                dialogs
                    .prepare_handle(id, DialogAction::Accept, None)
                    .unwrap()
                    .request
                    .accept
            );
        }
        if kind == DialogType::Prompt {
            assert!(
                dialogs
                    .prepare_handle(id, DialogAction::Accept, None)
                    .is_err()
            );
            for text in ["", "你好 🦀\nnext line"] {
                let accept = dialogs
                    .prepare_handle(id, DialogAction::Accept, Some(text.into()))
                    .unwrap();
                assert_eq!(accept.request.prompt_text.as_deref(), Some(text));
            }
        }
    }
}

#[test]
fn before_unload_requests_one_automatic_accept_and_prompt_edits_stay_local() {
    let dialogs = Dialogs::default();
    let automatic = dialogs
        .observe(DialogEvent::Opening {
            target: child("frame-a"),
            kind: DialogType::BeforeUnload,
            message: String::new(),
            default_prompt: String::new(),
            url: String::new(),
        })
        .unwrap();
    assert_eq!(
        automatic,
        Some(DialogRequest {
            target: child("frame-a"),
            accept: true,
            prompt_text: None,
        })
    );
    let prompt = open(&dialogs, main(), DialogType::Prompt);
    dialogs
        .replace_prompt(&prompt.metadata.id, "Edited response".into())
        .unwrap();
    let current = dialogs.current().unwrap();
    assert_eq!(current.prompt_text, "Edited response");
    assert_eq!(current.message, "Fixture message");
    assert_eq!(current.url, "https://fixture.example/");
    assert!(dialogs.check_method("Runtime.evaluate").is_err());
    dialogs.check_method("Page.handleJavaScriptDialog").unwrap();
    let alert = open(&dialogs, main(), DialogType::Alert);
    assert!(
        dialogs
            .replace_prompt(&prompt.metadata.id, "stale".into())
            .is_err()
    );
    assert!(
        dialogs
            .replace_prompt(&alert.metadata.id, "wrong type".into())
            .is_err()
    );
}

#[tokio::test]
async fn acknowledgement_alone_does_not_confirm_close() {
    let dialogs = Dialogs::default();
    let dialog = open(&dialogs, main(), DialogType::Confirm);
    let prepared = dialogs
        .prepare_handle(&dialog.metadata.id, DialogAction::Accept, None)
        .unwrap();
    let (ack, acknowledged) = oneshot::channel();
    let mut rpc = Box::pin(async move {
        ack.send(()).unwrap();
        Ok(())
    });
    let cancellation = CancellationToken::new();
    let confirmation = prepared.confirm(rpc.as_mut(), &cancellation);
    tokio::pin!(confirmation);
    tokio::select! {
        result=&mut confirmation=>panic!("ACK prematurely completed dialog: {result:?}"),
        _=acknowledged=>{},
    }
    assert!(matches!(
        futures_util::poll!(&mut confirmation),
        Poll::Pending
    ));
    dialogs
        .observe(DialogEvent::Closed { target: main() })
        .unwrap();
    let outcome = confirmation.await;
    outcome.result.unwrap();
    assert_eq!(outcome.dispatch, DispatchDisposition::Settled);
}

#[tokio::test]
async fn close_first_preserves_pending_dispatch_and_a_replacement_dialog() {
    let dialogs = Dialogs::default();
    let old = open(&dialogs, main(), DialogType::Confirm);
    let prepared = dialogs
        .prepare_handle(&old.metadata.id, DialogAction::Accept, None)
        .unwrap();
    let (began, begun) = oneshot::channel();
    let (reply, received) = oneshot::channel();
    let mut rpc = Box::pin(async move {
        began.send(()).unwrap();
        received.await.unwrap()
    });
    let cancellation = CancellationToken::new();
    let (outcome, newer) = {
        let confirmation = prepared.confirm(rpc.as_mut(), &cancellation);
        tokio::pin!(confirmation);
        tokio::select! {
            result=&mut confirmation=>panic!("unsettled RPC completed dialog: {result:?}"),
            _=begun=>{},
        }
        dialogs
            .observe(DialogEvent::Closed { target: main() })
            .unwrap();
        let newer = open(&dialogs, main(), DialogType::Prompt);
        (confirmation.await, newer)
    };
    outcome.result.unwrap();
    assert_eq!(outcome.dispatch, DispatchDisposition::Pending);
    assert_eq!(dialogs.current().unwrap().metadata.id, newer.metadata.id);
    assert!(
        dialogs
            .prepare_handle(&old.metadata.id, DialogAction::Dismiss, None)
            .is_err()
    );
    // The caller still owns the exact accepted future. A late transport error
    // is observed without revising the already proven close or replaying it.
    reply.send(Err(failed("late RPC rejection"))).unwrap();
    assert!(rpc.await.unwrap_err().to_string().contains("late RPC"));
}

#[tokio::test]
async fn immediate_close_during_dispatch_is_observed_without_an_ack() {
    let dialogs = Dialogs::default();
    let dialog = open(&dialogs, main(), DialogType::Alert);
    let prepared = dialogs
        .prepare_handle(&dialog.metadata.id, DialogAction::Dismiss, None)
        .unwrap();
    let observer = dialogs.clone();
    let (reply, received) = oneshot::channel::<Result<(), ToolError>>();
    let mut rpc = Box::pin(async move {
        observer
            .observe(DialogEvent::Closed { target: main() })
            .unwrap();
        received.await.unwrap()
    });
    let outcome = prepared
        .confirm(rpc.as_mut(), &CancellationToken::new())
        .await;
    outcome.result.unwrap();
    assert_eq!(outcome.dispatch, DispatchDisposition::Pending);
    reply.send(Ok(())).unwrap();
    rpc.await.unwrap();
}

#[tokio::test]
async fn close_and_late_rejection_in_the_same_dispatch_poll_keep_close_success() {
    let dialogs = Dialogs::default();
    let dialog = open(&dialogs, main(), DialogType::Confirm);
    let prepared = dialogs
        .prepare_handle(&dialog.metadata.id, DialogAction::Accept, None)
        .unwrap();
    let observer = dialogs.clone();
    let mut rpc = Box::pin(async move {
        observer
            .observe(DialogEvent::Closed { target: main() })
            .unwrap();
        Err(failed("rejection after observed close"))
    });
    let outcome = prepared
        .confirm(rpc.as_mut(), &CancellationToken::new())
        .await;
    outcome.result.unwrap();
    assert_eq!(outcome.dispatch, DispatchDisposition::Settled);
}

#[tokio::test]
async fn rejection_first_is_an_error_and_unrelated_child_events_do_not_confirm_close() {
    let dialogs = Dialogs::default();
    let dialog = open(&dialogs, main(), DialogType::Confirm);
    let prepared = dialogs
        .prepare_handle(&dialog.metadata.id, DialogAction::Accept, None)
        .unwrap();
    let mut rejected = Box::pin(async { Err(failed("fixture rejection")) });
    let outcome = prepared
        .confirm(rejected.as_mut(), &CancellationToken::new())
        .await;
    assert!(
        outcome
            .result
            .unwrap_err()
            .to_string()
            .contains("fixture rejection")
    );
    assert_eq!(outcome.dispatch, DispatchDisposition::Settled);

    let dialog = open(&dialogs, child("owner"), DialogType::Confirm);
    let prepared = dialogs
        .prepare_handle(&dialog.metadata.id, DialogAction::Dismiss, None)
        .unwrap();
    let mut acknowledged = Box::pin(async { Ok(()) });
    let cancellation = CancellationToken::new();
    let confirmation = prepared.confirm(acknowledged.as_mut(), &cancellation);
    tokio::pin!(confirmation);
    assert!(matches!(
        futures_util::poll!(&mut confirmation),
        Poll::Pending
    ));
    for target in [main(), child("sibling")] {
        dialogs.observe(DialogEvent::Closed { target }).unwrap();
        assert!(matches!(
            futures_util::poll!(&mut confirmation),
            Poll::Pending
        ));
        assert_eq!(dialogs.current().unwrap().metadata.id, dialog.metadata.id);
    }
    dialogs
        .observe(DialogEvent::Detached {
            target: child("owner"),
        })
        .unwrap();
    let outcome = confirmation.await;
    assert!(matches!(outcome.result, Err(ToolError::OutcomeUnknown(_))));
    assert_eq!(outcome.dispatch, DispatchDisposition::Settled);
}

#[tokio::test]
async fn cancellation_distinguishes_unstarted_from_accepted_work() {
    let dialogs = Dialogs::default();
    let dialog = open(&dialogs, main(), DialogType::Confirm);
    let prepared = dialogs
        .prepare_handle(&dialog.metadata.id, DialogAction::Accept, None)
        .unwrap();
    let polls = Arc::new(AtomicUsize::new(0));
    let count = polls.clone();
    let mut untouched = Box::pin(async move {
        count.fetch_add(1, Ordering::SeqCst);
        Ok(())
    });
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    let outcome = prepared.confirm(untouched.as_mut(), &cancelled).await;
    assert_eq!(outcome.dispatch, DispatchDisposition::NotStarted);
    assert_eq!(polls.load(Ordering::SeqCst), 0);

    let prepared = dialogs
        .prepare_handle(&dialog.metadata.id, DialogAction::Accept, None)
        .unwrap();
    let (began, begun) = oneshot::channel();
    let (reply, received) = oneshot::channel::<Result<(), ToolError>>();
    let mut pending = Box::pin(async move {
        began.send(()).unwrap();
        received.await.unwrap()
    });
    let cancellation = CancellationToken::new();
    let outcome = {
        let confirmation = prepared.confirm(pending.as_mut(), &cancellation);
        tokio::pin!(confirmation);
        tokio::select! {
            result=&mut confirmation=>panic!("unsettled RPC completed dialog: {result:?}"),
            _=begun=>{},
        }
        cancellation.cancel();
        confirmation.await
    };
    assert!(matches!(outcome.result, Err(ToolError::OutcomeUnknown(_))));
    assert_eq!(outcome.dispatch, DispatchDisposition::Pending);
    reply.send(Ok(())).unwrap();
    pending.await.unwrap();
}

#[test]
fn connection_loss_invalidates_objects_without_reusing_ids() {
    let dialogs = Dialogs::default();
    let old = open(&dialogs, main(), DialogType::Prompt);
    dialogs.observe(DialogEvent::Disconnected).unwrap();
    assert!(dialogs.current().is_none());
    assert!(
        dialogs
            .prepare_handle(&old.metadata.id, DialogAction::Dismiss, None)
            .is_err()
    );
    let replacement = Dialogs::default();
    let fresh = open(&replacement, main(), DialogType::Prompt);
    assert_ne!(old.metadata.id, fresh.metadata.id);
}

#[tokio::test]
async fn reply_barrier_covers_earlier_events_without_waiting_for_a_live_stream_to_empty() {
    use cua_driver_core::browser::cdp_ws::CdpEvent;
    let (send, events) = tokio::sync::mpsc::unbounded_channel();
    let (barriers, waiting) = tokio::sync::mpsc::unbounded_channel();
    for initial in 0..100 {
        send.send(CdpEvent {
            method: "fixture".into(),
            session_id: None,
            source_target_id: None,
            params_json: None,
            params: serde_json::json!({"initial":initial}),
        })
        .unwrap();
    }
    let earlier = Arc::new(AtomicUsize::new(0));
    let observed = earlier.clone();
    let producer = send.clone();
    let (reply, complete) = oneshot::channel();
    barriers.send(reply).unwrap();
    let worker = tokio::spawn(observe_events(events, waiting, move |event| {
        if event.params.get("initial").is_some() {
            observed.fetch_add(1, Ordering::SeqCst);
        }
        // Keep the event queue nonempty until the observer receives its reply.
        producer
            .send(CdpEvent {
                method: "later".into(),
                session_id: None,
                source_target_id: None,
                params_json: None,
                params: serde_json::Value::Null,
            })
            .unwrap();
    }));
    tokio::time::timeout(Duration::from_secs(1), complete)
        .await
        .expect("continuous later events starved the earlier reply")
        .unwrap();
    assert_eq!(earlier.load(Ordering::SeqCst), 100);
    worker.abort();
    let _ = worker.await;
}

fn controller_with_worker(worker: tokio::task::JoinHandle<()>) -> Controller {
    let (barriers, _) = tokio::sync::mpsc::unbounded_channel();
    Controller {
        link: Link {
            state: Dialogs::default(),
            barriers,
        },
        host: Arc::default(),
        worker,
        lifecycle: ControllerLifecycle::Open,
    }
}

#[derive(Default)]
struct RejectingHost {
    admissions: AtomicUsize,
}

impl crate::BrowserHostEffects for RejectingHost {
    fn spawn(&self, _: crate::HostEffectFuture) -> Result<(), ToolError> {
        self.admissions.fetch_add(1, Ordering::SeqCst);
        Err(failed("fixture rejects unpolled automatic effects"))
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_close_keeps_original_join_and_closing_refuses_new_host_effects() {
    use cua_driver_core::browser::cdp_ws::{CdpConnection, CdpEvent};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let (connected, peer) = tokio::join!(CdpConnection::connect_bounded(&url, usize::MAX), async {
        let (stream, _) = listener.accept().await.unwrap();
        tokio_tungstenite::accept_async(stream).await.unwrap()
    });
    let _peer = peer;
    let socket = super::super::Cdp {
        connection: Arc::new(connected.unwrap()),
        dialogs: None,
        extension_context: None,
        preparation: crate::browser::extension::PreparationTransport::NotRequired,
    };
    let host = Arc::new(RejectingHost::default());
    let capability: Arc<Mutex<Option<Arc<dyn crate::BrowserHostEffects>>>> =
        Arc::new(Mutex::new(Some(host.clone())));
    let observed = Dialogs::default();
    let worker_state = observed.clone();
    let worker_capability = capability.clone();
    let (started, began) = oneshot::channel();
    let (release, resume) = std::sync::mpsc::channel();
    let worker = tokio::spawn(async move {
        let mut children = std::collections::HashMap::new();
        let mut attached = |session: &str| {
            route_event(
                CdpEvent {
                    method: "Target.attachedToTarget".into(),
                    session_id: None,
                    source_target_id: None,
                    params_json: None,
                    params: serde_json::json!({"sessionId":session,"targetInfo":{"type":"iframe"}}),
                },
                &mut children,
                &socket,
                &worker_state,
                &worker_capability,
            );
        };
        attached("before-close");
        started.send(()).unwrap();
        // Abort cannot complete while this original task poll is in progress.
        // Dropping the test's sender also releases it if an assertion fails.
        resume.recv().unwrap();
        attached("after-close");
    });
    let (barriers, _) = tokio::sync::mpsc::unbounded_channel();
    let mut controller = Controller {
        link: Link {
            state: observed,
            barriers,
        },
        host: capability,
        worker,
        lifecycle: ControllerLifecycle::Open,
    };
    began.await.unwrap();
    assert_eq!(host.admissions.load(Ordering::SeqCst), 2);
    {
        let mut closing = Box::pin(controller.close());
        assert!(
            futures_util::poll!(&mut closing).is_pending(),
            "close completed before its original worker returned"
        );
    }
    controller.host_effects(Some(host.clone()));
    let mut closing = Box::pin(controller.close());
    assert!(
        futures_util::poll!(&mut closing).is_pending(),
        "retry replaced the still-pending original join"
    );
    release.send(()).unwrap();
    closing.await.unwrap();
    assert_eq!(
        host.admissions.load(Ordering::SeqCst),
        2,
        "closing controller re-admitted an automatic effect"
    );
    controller.close().await.unwrap();
}

#[tokio::test]
async fn close_accepts_original_worker_cancellation_and_is_repeatable() {
    let worker = tokio::spawn(std::future::pending::<()>());
    let mut controller = controller_with_worker(worker);
    controller.close().await.unwrap();
    controller.close().await.unwrap();
}

#[tokio::test]
async fn close_preserves_original_worker_panic_on_retry() {
    let (started, began) = oneshot::channel();
    let worker = tokio::spawn(async move {
        started.send(()).unwrap();
        panic!("original dialog worker panic fixture");
    });
    let mut controller = controller_with_worker(worker);
    began.await.unwrap();
    let original = controller.close().await.unwrap_err();
    assert!(matches!(original, ToolError::CleanupUnconfirmed(_)));
    assert!(
        original
            .to_string()
            .contains("original dialog worker panic fixture")
    );
    let retry = controller.close().await.unwrap_err();
    assert_eq!(retry.to_string(), original.to_string());
}

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
use crate::preview::{
    Capture, CaptureFuture, CapturedImage, PreviewAuthority, PreviewFrame, PreviewKind,
    PreviewSubject,
};
use std::{
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};

struct Pixels {
    started: Arc<tokio::sync::Semaphore>,
    release: Arc<tokio::sync::Semaphore>,
    calls: Arc<AtomicUsize>,
}
impl Capture for Pixels {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    fn same_source(&self, other: &dyn Capture) -> bool {
        other.as_any().is::<Self>()
    }
    fn authorize(
        &self,
        authority: Arc<dyn PreviewAuthority>,
        stop: CancellationToken,
    ) -> crate::AuthorizationFuture {
        authority.authorize(
            PreviewSubject::NativeWindow {
                operation_id: "retained-operation".into(),
                binding: crate::ComputerAppBinding {
                    pid: 7,
                    window_id: 9,
                    process_generation: "process".into(),
                },
            },
            stop,
        )
    }
    fn capture(
        &self,
        authority: Arc<dyn PreviewAuthority>,
        stop: CancellationToken,
    ) -> CaptureFuture {
        let authorization = self.authorize(authority, stop);
        let started = self.started.clone();
        let release = self.release.clone();
        let calls = self.calls.clone();
        Box::pin(async move {
            authorization.await?;
            calls.fetch_add(1, Ordering::SeqCst);
            started.add_permits(1);
            release.acquire().await.unwrap().forget();
            Ok(CapturedImage::Frame(PreviewFrame {
                target_id: "producer".into(),
                binding_id: "producer".into(),
                revision: 1,
                mime_type: "image/jpeg",
                bytes: vec![1],
                width: 1,
                height: 1,
            }))
        })
    }
}
async fn next_event(events: &mut mpsc::UnboundedReceiver<Event>) -> Event {
    tokio::time::timeout(Duration::from_secs(3), events.recv())
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn preview_rpc_is_owner_session_epoch_scoped_and_retirement_rejects_late_pixels() {
    let driver = Arc::new(Mutex::new(Driver::default()));
    let disconnected = CancellationToken::new();
    let (events, mut replies) = mpsc::unbounded_channel();
    let callbacks = WorkerCallbacks::new(Arc::new(|_| Ok(())));
    let mut owner = Owner::new("session".into(), driver.clone(), disconnected.clone());
    let native_epoch = NativeEpochId::new();
    let registry = owner.resources.preview();
    let local =
        crate::session::Session::with_owner(driver.clone(), native_epoch, owner.resources.clone());
    owner.epochs.insert(
        "epoch".into(),
        Epoch::new(
            "session".into(),
            local,
            events.clone(),
            disconnected.clone(),
            "owner".into(),
            "epoch".into(),
            callbacks.clone(),
        ),
    );
    let mut owners = HashMap::from([("owner".into(), owner)]);
    let context = WorkerContext {
        driver: &driver,
        events: &events,
        disconnected: &disconnected,
        callbacks: &callbacks,
    };
    let started = Arc::new(tokio::sync::Semaphore::new(0));
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let calls = Arc::new(AtomicUsize::new(0));
    registry.register(
        native_epoch,
        "bound".into(),
        PreviewKind::App,
        "bound".into(),
        Arc::new(Pixels {
            started: started.clone(),
            release: release.clone(),
            calls: calls.clone(),
        }),
    );
    let target = registry.targets().remove(0);
    for (owner, epoch, session) in [
        ("other", "epoch", "session"),
        ("owner", "other", "session"),
        ("owner", "epoch", "other"),
    ] {
        let request = Request::PreviewRead {
            owner: owner.into(),
            epoch: epoch.into(),
            session: session.into(),
            target: target.clone(),
            pixels: true,
        };
        assert!(dispatch(request, 1, &mut owners, CancellationToken::new(), &context).is_err());
    }
    let mut stale = target.clone();
    stale.revision += 1;
    assert!(
        dispatch(
            Request::PreviewRead {
                owner: "owner".into(),
                epoch: "epoch".into(),
                session: "session".into(),
                target: stale,
                pixels: true
            },
            2,
            &mut owners,
            CancellationToken::new(),
            &context
        )
        .is_err()
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    // Read-only authorization goes through the pending request's Host callback,
    // never through the mutation/effect callback family.
    dispatch(
        Request::PreviewRead {
            owner: "owner".into(),
            epoch: "epoch".into(),
            session: "session".into(),
            target: target.clone(),
            pixels: false,
        },
        3,
        &mut owners,
        CancellationToken::new(),
        &context,
    )
    .unwrap();
    match next_event(&mut replies).await {
        Event::Authorization {
            id: 3,
            mode: AuthorizationMode::Check,
            request:
                BrowserAuthorizationRequest::Preview(
                    super::super::preview::AuthorizationRequest::Subject(
                        PreviewSubject::NativeWindow { operation_id, .. },
                    ),
                ),
            reply,
        } => {
            assert_eq!(operation_id, "retained-operation");
            reply.send(Err(Failure::Failed("revoked".into()))).unwrap();
        }
        _ => panic!("preview asked for something other than its readonly Host check"),
    }
    assert!(matches!(
        next_event(&mut replies).await,
        Event::Response {
            id: 3,
            result: Err(_),
            ..
        }
    ));
    // Re-publish a newly successful binding after the denied capability was removed.
    registry.register(
        native_epoch,
        "bound".into(),
        PreviewKind::App,
        "bound".into(),
        Arc::new(Pixels {
            started: started.clone(),
            release: release.clone(),
            calls: calls.clone(),
        }),
    );
    let target = registry.targets().remove(0);
    dispatch(
        Request::PreviewRead {
            owner: "owner".into(),
            epoch: "epoch".into(),
            session: "session".into(),
            target: target.clone(),
            pixels: true,
        },
        4,
        &mut owners,
        CancellationToken::new(),
        &context,
    )
    .unwrap();
    match next_event(&mut replies).await {
        Event::Authorization {
            id: 4,
            mode: AuthorizationMode::Check,
            reply,
            ..
        } => reply.send(Ok(())).unwrap(),
        _ => panic!("pixel read must check the current Host grant"),
    }
    tokio::time::timeout(Duration::from_secs(3), started.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    let cleanup = owners
        .get_mut("owner")
        .unwrap()
        .epochs
        .get_mut("epoch")
        .unwrap()
        .close();
    assert!(registry.targets().is_empty());
    release.add_permits(1);
    assert!(matches!(
        next_event(&mut replies).await,
        Event::Response {
            id: 4,
            result: Err(_),
            ..
        }
    ));
    assert!(
        dispatch(
            Request::PreviewRead {
                owner: "owner".into(),
                epoch: "epoch".into(),
                session: "session".into(),
                target,
                pixels: true
            },
            5,
            &mut owners,
            CancellationToken::new(),
            &context
        )
        .is_err()
    );
    tokio::time::timeout(Duration::from_secs(3), observe_retirement(cleanup))
        .await
        .unwrap()
        .unwrap();
    let cleanup = owners.get_mut("owner").unwrap().close();
    tokio::time::timeout(Duration::from_secs(3), observe_retirement(cleanup))
        .await
        .unwrap()
        .unwrap();
}

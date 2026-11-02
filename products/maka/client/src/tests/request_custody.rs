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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_a_pending_subscription_preserves_cleanup_and_allows_a_finite_replacement() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let fixture = Fixture::new().await;
        let client = fixture.client().await;
        let obsolete = Arc::new(
            client
                .subscribe("agent", "watch", json!({"holdCleanup":true}))
                .await
                .unwrap(),
        );
        assert!(matches!(
            obsolete.next().await.unwrap(),
            Some(SubscriptionEvent::Item(value)) if value == json!({"sent":0})
        ));
        let (entered, pulling) = tokio::sync::oneshot::channel();
        let pending = tokio::spawn({
            let obsolete = obsolete.clone();
            async move {
                let next = obsolete.next();
                tokio::pin!(next);
                assert!(futures_util::poll!(next.as_mut()).is_pending());
                entered.send(()).unwrap();
                next.await
            }
        });
        pulling.await.unwrap();
        let closing = tokio::spawn({
            let obsolete = obsolete.clone();
            async move { obsolete.close().await }
        });
        fixture.counter.started.notified().await;
        assert_eq!(fixture.counter.watches_closed.load(Ordering::SeqCst), 1);
        assert!(!closing.is_finished());

        let replacement = client
            .subscribe("agent", "watch", json!({"once":true}))
            .await
            .unwrap();
        assert!(matches!(
            replacement.next().await.unwrap(),
            Some(SubscriptionEvent::Finished(value)) if value == json!({"sent":0})
        ));
        assert!(replacement.next().await.unwrap().is_none());
        assert_eq!(client.pending_requests().await, 1);
        assert!(!closing.is_finished());

        fixture.counter.release.notify_one();
        assert!(pending.await.unwrap().is_err());
        closing.await.unwrap().unwrap();
        assert_eq!(client.pending_requests().await, 0);
        client.close().await.unwrap();
        fixture.finish().await;
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retained_subscriptions_do_not_block_queries_or_controls_and_close_drains_every_owner() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let fixture = Fixture::new().await;
        let client = fixture.client().await;
        let mut retained = Vec::new();
        // Keep both displayed and abandoned subscriptions live alongside a control.
        for index in 0..3 {
            let subscription = client
                .subscribe("agent", "watch", Value::Null)
                .await
                .unwrap();
            assert!(matches!(
                subscription.next().await.unwrap(),
                Some(SubscriptionEvent::Item(value)) if value == json!({"sent": 0})
            ));
            if index % 2 == 0 {
                // Losing the display handle must not lose the scope's cleanup custody.
                drop(subscription);
            } else {
                retained.push(subscription);
            }
        }
        assert_eq!(client.pending_requests().await, 3);
        assert_eq!(fixture.counter.watches_closed.load(Ordering::SeqCst), 0);

        assert_eq!(
            client.query("agent", "read", Value::Null).await.unwrap(),
            json!({"sent": 0})
        );
        let control = client
            .control(
                Uuid::new_v4(),
                "editQueue",
                json!({"sessionId": "session-one"}),
            )
            .await
            .unwrap();
        control.prepare().await.unwrap();
        let reply = control.confirm().await.unwrap();
        assert!(matches!(
            reply.receipt,
            Receipt::Recorded {
                outcome: OperationOutcome::Returned { value }, ..
            } if value == json!({"sent": 1})
        ));
        assert_eq!(fixture.counter.effects.load(Ordering::SeqCst), 1);
        assert_eq!(client.pending_requests().await, 3);

        client.close().await.unwrap();
        assert_eq!(client.pending_requests().await, 0);
        assert_eq!(fixture.counter.watches_closed.load(Ordering::SeqCst), 3);
        for subscription in retained {
            assert!(subscription.next().await.unwrap().is_none());
        }
        assert_eq!(
            client
                .query("agent", "read", Value::Null)
                .await
                .unwrap_err(),
            "client scope is closing"
        );
        fixture.finish().await;
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_cancels_a_withheld_opening_and_waits_for_the_original_anchor_ack() {
    close_with_withheld_opening(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn withheld_opening_cancellation_does_not_substitute_for_the_original_anchor_ack() {
    close_with_withheld_opening(false).await;
}

async fn close_with_withheld_opening(acknowledge: bool) {
    use maka_host_runtime::{
        application::{
            host::protocol::{Opening, Request as HostRequest, Response, SessionControl},
            transport::wire,
        },
        ipc,
    };
    use tokio::io::AsyncReadExt;

    tokio::time::timeout(Duration::from_secs(30), async {
        let fixture = Fixture::new().await;
        #[cfg(unix)]
        let address = fixture.directory.path().join("opening-gate.sock");
        #[cfg(windows)]
        let address = PathBuf::from(format!(r"\\.\pipe\maka-opening-gate-{}", Uuid::new_v4()));
        let mut listener = LocalListener::bind(&address).unwrap();
        let (opening_entered, entered) = tokio::sync::oneshot::channel();
        let (opening_closed, closed) = tokio::sync::oneshot::channel();
        let (anchor_closed, anchor_ack) = tokio::sync::oneshot::channel();
        let (release_ack, release) = tokio::sync::oneshot::channel();
        let proxy = tokio::spawn({
            let target = fixture.address.clone();
            let epoch = fixture.host.epoch();
            async move {
                let mut workers = tokio::task::JoinSet::new();
                let mut opening_gate = Some((opening_entered, opening_closed));
                let mut anchor_gate = Some((anchor_closed, release));
                let mut session = None;
                for index in 0..3 {
                    let mut downstream = wire::Reader::new(listener.accept().await.unwrap());
                    let opening: Opening = downstream.read().await.unwrap();
                    assert_eq!(opening.epoch, Some(epoch));
                    match &opening.request {
                        HostRequest::Connect => assert_eq!(index, 0),
                        HostRequest::Call { session: actual } => assert_eq!(Some(*actual), session),
                        _ => panic!("unexpected proxy opening"),
                    }
                    let mut upstream = wire::Reader::new(ipc::connect(&target).await.unwrap());
                    wire::write(&mut upstream.inner, &opening).await.unwrap();
                    let response: Response = upstream.read().await.unwrap();
                    if let Response::Connected(connected) = &response {
                        session = Some(connected.session);
                    }
                    if index == 2 {
                        assert!(matches!(response, Response::Accepted));
                        let (entered, closed) = opening_gate.take().unwrap();
                        workers.spawn(async move {
                            entered.send(()).unwrap();
                            let mut byte = [0];
                            assert_eq!(downstream.inner.read(&mut byte).await.unwrap(), 0);
                            drop(upstream);
                            closed.send(()).unwrap();
                        });
                    } else {
                        wire::write(&mut downstream.inner, &response).await.unwrap();
                        if index == 0 {
                            let (closed, release) = anchor_gate.take().unwrap();
                            workers.spawn(async move {
                                assert!(matches!(
                                    downstream.read::<SessionControl>().await.unwrap(),
                                    SessionControl::Close
                                ));
                                wire::write(&mut upstream.inner, &SessionControl::Close)
                                    .await
                                    .unwrap();
                                let response = upstream.read::<Response>().await.unwrap();
                                assert!(matches!(response, Response::Closed));
                                closed.send(()).unwrap();
                                if release.await.unwrap() {
                                    wire::write(&mut downstream.inner, &response).await.unwrap();
                                }
                            });
                        } else {
                            workers.spawn(async move {
                                // Cancellation may close a peer with bytes still buffered.
                                if let Err(error) = tokio::io::copy_bidirectional(
                                    &mut downstream.inner,
                                    &mut upstream.inner,
                                )
                                .await
                                {
                                    assert!(
                                        matches!(
                                            error.kind(),
                                            std::io::ErrorKind::ConnectionReset
                                                | std::io::ErrorKind::BrokenPipe
                                        ),
                                        "query relay failed: {error}"
                                    );
                                }
                            });
                        }
                    }
                }
                drop(listener);
                while let Some(worker) = workers.join_next().await {
                    worker.unwrap();
                }
            }
        });
        let host = HostClient::connect(&address, Some(fixture.host.epoch()))
            .await
            .unwrap();
        let journal = Journal::open(&fixture.directory.path().join("client.db"))
            .await
            .unwrap();
        let client = Client::new(host, journal, "receipts".into()).unwrap();
        let query = tokio::spawn({
            let client = client.clone();
            async move {
                client
                    .query("agent", "read", json!({"holdUntilCancelled":true}))
                    .await
            }
        });
        fixture.counter.started.notified().await;
        assert_eq!(client.pending_requests().await, 1);
        let opening = tokio::spawn({
            let client = client.clone();
            async move { client.query("agent", "read", Value::Null).await }
        });
        entered.await.unwrap();
        let close = tokio::spawn({
            let client = client.clone();
            async move { client.close().await }
        });
        assert!(query.await.unwrap().is_err());
        assert_eq!(
            opening.await.unwrap().unwrap_err(),
            "client scope is closing"
        );
        closed.await.unwrap();
        anchor_ack.await.unwrap();
        assert!(
            !close.is_finished(),
            "opening cancellation cannot acknowledge anchor cleanup"
        );
        release_ack.send(acknowledge).unwrap();
        let result = close.await.unwrap();
        if acknowledge {
            result.unwrap();
            client.close().await.unwrap();
        } else {
            assert!(
                result.is_err(),
                "EOF cannot confirm original anchor cleanup"
            );
        }
        proxy.await.unwrap();
        fixture.finish().await;
    })
    .await
    .unwrap();
}

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

use std::{pin::Pin, sync::Arc, task::Poll, time::Duration};

use futures::{AsyncReadExt as _, AsyncWriteExt as _, channel::mpsc, future::poll_fn};
use libp2p::{PeerId, core::muxing::StreamMuxer};
use tokio_util::{compat::TokioAsyncReadCompatExt as _, sync::CancellationToken};
use webrtc::peer_connection::{PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler};

use super::{
    UpgradeOptions, UpgradeRole, WebRtcConnection,
    lifetime::PeerConnectionLifetime,
    muxer::{keep_init_channel, ready_substream},
    upgrade::UpgradeError,
    upgrade_connection,
};

fn task_count() -> usize {
    tokio::runtime::Handle::current()
        .metrics()
        .num_alive_tasks()
}

async fn wait_for_tasks(baseline: usize) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while task_count() != baseline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("tasks remaining: {}, expected {baseline}", task_count()));
}

struct Handler;
#[async_trait::async_trait]
impl PeerConnectionEventHandler for Handler {}

#[tokio::test]
async fn unopened_channels_release_their_peer_connection_on_close_and_drop() {
    let baseline = task_count();
    for explicit_close in [true, false] {
        let handler = Arc::new(Handler);
        let weak = Arc::downgrade(&handler);
        let pc: Arc<dyn PeerConnection> = Arc::new(
            PeerConnectionBuilder::new()
                .with_handler(handler)
                .with_udp_addrs(vec!["127.0.0.1:0".to_owned()])
                .build()
                .await
                .expect("peer connection"),
        );
        let cancellation = CancellationToken::new();
        let init = pc.create_data_channel("init", None).await.unwrap();
        let other = pc.create_data_channel("", None).await.unwrap();
        let mut lifetime = PeerConnectionLifetime::new(pc, cancellation.clone());
        let (opened, _receiver) = mpsc::channel(1);
        keep_init_channel(init, opened, cancellation.clone());
        let opening = tokio::spawn(ready_substream(other, "test", None, cancellation));
        tokio::task::yield_now().await;
        assert!(weak.strong_count() > 0);
        if explicit_close {
            lifetime.close().await.unwrap();
        }
        drop(lifetime);
        assert!(opening.await.unwrap().is_err());
        wait_for_tasks(baseline).await;
        assert_eq!(weak.strong_count(), 0, "channel retained the PC handler");
    }
}

async fn connected_pair(cancellation: CancellationToken) -> (WebRtcConnection, WebRtcConnection) {
    let a = PeerId::random();
    let b = PeerId::random();
    let (left, right) = tokio::io::duplex(256 * 1024);
    let options = UpgradeOptions {
        cancellation,
        ..UpgradeOptions::default()
    };
    let (left, right) = tokio::join!(
        upgrade_connection(left.compat(), b, b, UpgradeRole::Offerer, options.clone()),
        upgrade_connection(right.compat(), a, a, UpgradeRole::Answerer, options),
    );
    (left.expect("offerer").1, right.expect("answerer").1)
}

#[tokio::test]
async fn connected_churn_releases_workers_with_live_and_undelivered_streams() {
    let baseline = task_count();
    tokio::time::timeout(Duration::from_secs(60), async {
        for round in 0..32 {
            let cancellation = CancellationToken::new();
            let (mut left, mut right) = connected_pair(cancellation.clone()).await;
            // The signaling attempt can retire while the direct route is in use.
            cancellation.cancel();
            let (outbound, inbound) = tokio::join!(
                poll_fn(|cx| Pin::new(&mut left).poll_outbound(cx)),
                poll_fn(|cx| Pin::new(&mut right).poll_inbound(cx)),
            );
            let (mut outbound, mut inbound) = (outbound.unwrap(), inbound.unwrap());
            let payload = b"connection survives signaling cancellation";
            outbound.write_all(payload).await.unwrap();
            outbound.flush().await.unwrap();
            let mut received = vec![0; payload.len()];
            inbound.read_exact(&mut received).await.unwrap();
            assert_eq!(received, payload);
            let queued = poll_fn(|cx| Pin::new(&mut left).poll_outbound(cx))
                .await
                .unwrap();
            match round % 3 {
                0 => {
                    let (a, b) = tokio::join!(
                        poll_fn(|cx| Pin::new(&mut left).poll_close(cx)),
                        poll_fn(|cx| Pin::new(&mut right).poll_close(cx)),
                    );
                    a.unwrap();
                    b.unwrap();
                }
                1 => {
                    // Exercise dropping a close future before it completes.
                    poll_fn(|cx| {
                        let _ = Pin::new(&mut left).poll_close(cx);
                        Poll::Ready(())
                    })
                    .await;
                }
                _ => {}
            }
            drop((left, right));
            // Live application streams must not retain any channel workers.
            wait_for_tasks(baseline).await;
            drop((outbound, inbound, queued));
        }
    })
    .await
    .expect("connection churn timeout");
}

#[tokio::test]
async fn dropping_connections_cancels_backpressured_channel_workers() {
    let baseline = task_count();
    let (mut left, mut right) = connected_pair(CancellationToken::new()).await;
    let (outbound, inbound) = tokio::join!(
        poll_fn(|cx| Pin::new(&mut left).poll_outbound(cx)),
        poll_fn(|cx| Pin::new(&mut right).poll_inbound(cx)),
    );
    let mut outbound = outbound.unwrap();
    let inbound = inbound.unwrap();
    // Exceed the send buffer and both queues while the application never reads.
    let writer =
        tokio::spawn(async move { outbound.write_all(&vec![0x5a; 4 * 1024 * 1024]).await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!writer.is_finished(), "writer should be backpressured");
    drop((left, right));
    assert!(
        tokio::time::timeout(Duration::from_secs(5), writer)
            .await
            .expect("writer released by connection teardown")
            .unwrap()
            .is_err()
    );
    wait_for_tasks(baseline).await;
    drop(inbound);
}

#[tokio::test]
async fn unsuccessful_upgrades_release_workers() {
    let baseline = task_count();
    for scenario in ["deadline", "cancel", "abort", "signaling-ended"] {
        let peer = PeerId::random();
        let (signaling, remote) = tokio::io::duplex(256 * 1024);
        let options = UpgradeOptions {
            deadline: Duration::from_millis(250),
            ..UpgradeOptions::default()
        };
        let cancellation = options.cancellation.clone();
        let task = tokio::spawn(upgrade_connection(
            signaling.compat(),
            peer,
            peer,
            UpgradeRole::Offerer,
            options,
        ));
        tokio::time::timeout(Duration::from_secs(2), async {
            while task_count() < baseline + 3 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("upgrade started its driver and init worker");
        match scenario {
            "cancel" => cancellation.cancel(),
            "abort" => task.abort(),
            "signaling-ended" => drop(remote),
            _ => {}
        }
        match (scenario, task.await) {
            ("deadline", Ok(Err(UpgradeError::Deadline)))
            | ("cancel", Ok(Err(UpgradeError::Cancelled)))
            | ("signaling-ended", Ok(Err(UpgradeError::SignalingEnded))) => {}
            ("abort", Err(error)) if error.is_cancelled() => {}
            _ => panic!("unexpected upgrade result for {scenario}"),
        }
        wait_for_tasks(baseline).await;
    }
}

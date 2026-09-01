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

use std::{pin::Pin, time::Duration};

use futures::{AsyncReadExt as _, AsyncWriteExt as _, future::poll_fn};
use libp2p::{
    PeerId,
    core::{
        Endpoint,
        muxing::StreamMuxer,
        transport::{DialOpts, PortUse, Transport},
    },
};
use tokio_util::compat::TokioAsyncReadCompatExt as _;

use super::{
    UpgradeOptions, UpgradeRole, WebRtcTransport, upgrade::MAX_INBOUND_SUBSTREAMS,
    upgrade_connection,
};

#[tokio::test]
async fn authenticated_signaling_yields_a_libp2p_stream() {
    let peer_a = PeerId::random();
    let peer_b = PeerId::random();
    let (signaling_a, signaling_b) = tokio::io::duplex(256 * 1024);
    let options = UpgradeOptions {
        deadline: Duration::from_secs(10),
        ..UpgradeOptions::default()
    };

    let (offer, answer) = tokio::join!(
        upgrade_connection(
            signaling_a.compat(),
            peer_b,
            peer_b,
            UpgradeRole::Offerer,
            options.clone(),
        ),
        upgrade_connection(
            signaling_b.compat(),
            peer_a,
            peer_a,
            UpgradeRole::Answerer,
            options,
        )
    );
    let (_, connection_a) = offer.expect("offerer upgrade");
    let (_, mut connection_b) = answer.expect("answerer upgrade");
    let (mut transport, control) = WebRtcTransport::new();
    let address = control
        .register_outbound(peer_b, connection_a)
        .expect("register outbound connection");
    let (_, mut connection_a) = transport
        .dial(
            address,
            DialOpts {
                role: Endpoint::Dialer,
                port_use: PortUse::Reuse,
            },
        )
        .expect("dial prepared WebRTC connection")
        .await
        .expect("prepared WebRTC connection");

    let (outbound, inbound) = tokio::join!(
        poll_fn(|cx| Pin::new(&mut connection_a).poll_outbound(cx)),
        poll_fn(|cx| Pin::new(&mut connection_b).poll_inbound(cx)),
    );
    let mut outbound = outbound.expect("outbound WebRTC stream");
    let mut inbound = inbound.expect("inbound WebRTC stream");
    let payload = b"maka-runtime-host-webrtc";

    outbound.write_all(payload).await.expect("write payload");
    outbound.flush().await.expect("flush payload");
    let mut received = vec![0; payload.len()];
    inbound
        .read_exact(&mut received)
        .await
        .expect("read payload");
    assert_eq!(received, payload);
}

#[tokio::test]
async fn a_slow_reader_backpressures_without_losing_bytes() {
    let (mut connection_a, mut connection_b) = connected_pair().await;
    let (outbound, inbound) = tokio::join!(
        poll_fn(|cx| Pin::new(&mut connection_a).poll_outbound(cx)),
        poll_fn(|cx| Pin::new(&mut connection_b).poll_inbound(cx)),
    );
    let mut outbound = outbound.expect("outbound WebRTC stream");
    let mut inbound = inbound.expect("inbound WebRTC stream");
    let payload = vec![0x5a; 20 * 16 * 1024];
    let expected = payload.clone();
    let writer = tokio::spawn(async move {
        outbound.write_all(&payload).await.expect("write payload");
        outbound.flush().await.expect("flush payload");
    });

    tokio::time::sleep(Duration::from_millis(100)).await;
    let mut received = vec![0; expected.len()];
    tokio::time::timeout(Duration::from_secs(10), inbound.read_exact(&mut received))
        .await
        .expect("slow-reader receive timeout")
        .expect("slow-reader receive failed");
    tokio::time::timeout(Duration::from_secs(10), writer)
        .await
        .expect("slow-reader writer timeout")
        .expect("slow-reader writer task failed");
    assert_eq!(received, expected);
}

#[tokio::test]
async fn inbound_substreams_are_bounded_per_connection() {
    let (mut connection_a, mut connection_b) = connected_pair().await;
    let mut outbound = Vec::new();
    for _ in 0..=MAX_INBOUND_SUBSTREAMS {
        outbound.push(
            tokio::time::timeout(
                Duration::from_secs(5),
                poll_fn(|cx| Pin::new(&mut connection_a).poll_outbound(cx)),
            )
            .await
            .expect("outbound substream timeout")
            .expect("outbound substream failed"),
        );
    }
    let mut inbound = Vec::new();
    for _ in 0..MAX_INBOUND_SUBSTREAMS {
        inbound.push(
            tokio::time::timeout(
                Duration::from_secs(5),
                poll_fn(|cx| Pin::new(&mut connection_b).poll_inbound(cx)),
            )
            .await
            .expect("inbound substream timeout")
            .expect("inbound substream failed"),
        );
    }
    assert!(
        tokio::time::timeout(
            Duration::from_millis(250),
            poll_fn(|cx| Pin::new(&mut connection_b).poll_inbound(cx)),
        )
        .await
        .is_err(),
        "the excess inbound substream escaped the per-connection bound",
    );
    drop((outbound, inbound));
}

async fn connected_pair() -> (super::WebRtcConnection, super::WebRtcConnection) {
    let peer_a = PeerId::random();
    let peer_b = PeerId::random();
    let (signaling_a, signaling_b) = tokio::io::duplex(256 * 1024);
    let options = UpgradeOptions {
        deadline: Duration::from_secs(10),
        ..UpgradeOptions::default()
    };
    let (offer, answer) = tokio::join!(
        upgrade_connection(
            signaling_a.compat(),
            peer_b,
            peer_b,
            UpgradeRole::Offerer,
            options.clone(),
        ),
        upgrade_connection(
            signaling_b.compat(),
            peer_a,
            peer_a,
            UpgradeRole::Answerer,
            options,
        )
    );
    (
        offer.expect("offerer upgrade").1,
        answer.expect("answerer upgrade").1,
    )
}

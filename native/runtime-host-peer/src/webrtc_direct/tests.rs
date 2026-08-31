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
use libp2p::{PeerId, core::muxing::StreamMuxer};
use tokio_util::compat::TokioAsyncReadCompatExt as _;

use super::{UpgradeOptions, UpgradeRole, upgrade_connection};

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
    let (_, mut connection_a) = offer.expect("offerer upgrade");
    let (_, mut connection_b) = answer.expect("answerer upgrade");

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

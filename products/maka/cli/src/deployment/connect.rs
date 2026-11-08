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

use super::{RootId, activation};
use clap::Args;
use maka_host_runtime::{
    HostError,
    application::{
        host::{
            VERSION,
            protocol::{Opening, Response},
        },
        transport::wire,
    },
};
use std::time::Duration;
#[cfg(unix)]
use tokio::io::AsyncWriteExt;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_util::sync::CancellationToken;

#[derive(Args)]
pub(crate) struct Connect {
    #[arg(long)]
    root_id: RootId,
    #[arg(long = "framed", required = true)]
    _framed: bool,
    /// Confirm the same Linux filesystem was remounted, preserving root identity.
    #[arg(long)]
    repair_root_after_remount: bool,
}

impl Connect {
    pub async fn run(self) -> Result<(), HostError> {
        let maka_transport::stdio::Stdio {
            input,
            mut output,
            mut output_done,
        } = maka_transport::stdio::Stdio::open()?;
        let cancel = CancellationToken::new();
        let _signals = crate::signals::watch(cancel.clone())?;
        let result = tokio::select! {
            result = self.bridge(input, &mut output) => result,
            _ = cancel.cancelled() => Ok(()),
            result = &mut output_done => {
                result??;
                return Err("Host bridge output closed".into());
            }
        };
        // Duplex shutdown alone only proves that bytes were queued. Wait for
        // the stdout worker's final flush, bounded even if the consumer stalls.
        drop(output);
        let flushed = tokio::time::timeout(Duration::from_secs(5), output_done)
            .await
            .map_err(HostError::from)
            .and_then(|result| result.map_err(HostError::from))
            .and_then(|result| result.map_err(HostError::from));
        result.and(flushed)
    }

    async fn bridge(
        &self,
        input: impl AsyncRead + Unpin,
        output: &mut (impl AsyncWrite + Unpin),
    ) -> Result<(), HostError> {
        // Silent or incompatible input cannot start a Host or reserve its executor.
        let mut input = wire::Reader::new(input);
        let mut opening: Opening =
            tokio::time::timeout(Duration::from_secs(5), input.read()).await??;
        if opening.version != VERSION {
            return Err("unsupported public application Host protocol".into());
        }
        let (deployment, lease) =
            activation::prepare(&self.root_id, self.repair_root_after_remount).await?;
        let (probe, live) = activation::connect_or_launch(&deployment, lease.clone()).await?;
        let epoch = uuid::Uuid::parse_str(&live.epoch)?;
        if opening.epoch.is_some_and(|expected| expected != epoch) {
            return Err("Host incarnation changed before bridge admission".into());
        }
        opening.epoch = Some(epoch);
        let mut stream = wire::Reader::new(probe.open_bridge().await?);
        let response: Response = tokio::time::timeout(Duration::from_secs(5), async {
            wire::write(&mut stream.inner, &opening).await?;
            stream.read().await
        })
        .await??;
        match &response {
            Response::Connected(connected)
                if connected.epoch != epoch
                    || connected.version != VERSION
                    || connected.source.state_domain != deployment.root_id =>
            {
                return Err("Host identity changed during bridge admission".into());
            }
            Response::Status(status)
                if status.epoch != epoch
                    || status.version != VERSION
                    || status.root_id != deployment.root_id
                    || status.pid != live.pid =>
            {
                return Err("Host identity changed during bridge status".into());
            }
            _ => {}
        }
        lease.validate()?;
        drop(probe);
        drop(lease);
        wire::write(output, &response).await?;
        // Carry every prefetched byte across the boundary, including pipelined calls.
        relay(&mut input.inner, output, stream.inner).await?;
        Ok(())
    }
}

async fn relay(
    input: &mut (impl AsyncRead + Unpin),
    output: &mut (impl AsyncWrite + Unpin),
    stream: impl AsyncRead + AsyncWrite + Unpin,
) -> std::io::Result<()> {
    let (mut read, mut write) = tokio::io::split(stream);
    let downstream = tokio::io::copy(&mut read, output);
    tokio::pin!(downstream);
    tokio::select! {
        result = tokio::io::copy(input, &mut write) => {
            result?;
            #[cfg(unix)]
            {
                // Preserve this same copy future: it may own a partially
                // written response buffer while stdout applies backpressure.
                write.shutdown().await?;
                downstream.await?;
            }
            // Windows named pipes cannot half-close. EOF disconnects the
            // client without promising queued writes or final responses;
            // it never retires the independently owned Host.
        },
        result = &mut downstream => { result?; },
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    #[tokio::test]
    async fn input_eof_preserves_a_response_already_blocked_on_output() {
        tokio::time::timeout(Duration::from_secs(5), async {
            let (mut sender, mut input) = tokio::io::duplex(16);
            let (mut output, mut receiver) = tokio::io::duplex(256);
            let (stream, server) = tokio::io::duplex(16 * 1024);
            let bridge = tokio::spawn(async move { relay(&mut input, &mut output, stream).await });
            let (mut server_read, mut server_write) = tokio::io::split(server);
            let payload: Vec<_> = (0..128 * 1024).map(|index| (index % 251) as u8).collect();
            let expected = payload.clone();
            let server = tokio::spawn(async move {
                server_write.write_all(&payload).await.unwrap();
                server_write.shutdown().await.unwrap();
            });
            let first = receiver.read_u8().await.unwrap();
            sender.shutdown().await.unwrap();
            // This EOF proves the bridge handled input EOF while downstream
            // was blocked, before allowing the output consumer to drain.
            assert_eq!(server_read.read(&mut [0]).await.unwrap(), 0);
            let mut actual = vec![first];
            receiver.read_to_end(&mut actual).await.unwrap();
            assert_eq!(actual, expected);
            bridge.await.unwrap().unwrap();
            server.await.unwrap();
        })
        .await
        .unwrap();
    }
}

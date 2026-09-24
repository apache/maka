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

use crate::{
    Error,
    interaction::{Callback, Response},
};
use agent_client_protocol::{Client, Lines, V2ConnectionTo, schema::v2 as acp};
use futures_util::{StreamExt, sink};
use std::{io, time::Duration};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio_util::{
    codec::{FramedRead, LinesCodec},
    sync::CancellationToken,
};

const MAX_LINE: usize = 8 * 1024 * 1024;

/// SDK owns JSON-RPC framing, correlation and dispatch; this adapter bounds I/O.
pub(crate) fn lines<R, W>(
    input: R,
    output: W,
) -> impl agent_client_protocol::ConnectTo<agent_client_protocol::Agent>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let incoming = FramedRead::new(input, LinesCodec::new_with_max_length(MAX_LINE))
        .map(|line| line.map_err(io::Error::other));
    let outgoing = sink::unfold(output, async |mut output, line: String| {
        if line.len() > MAX_LINE {
            return Err(io::Error::other("ACP output exceeds frame limit"));
        }
        tokio::time::timeout(Duration::from_secs(15), async {
            output.write_all(line.as_bytes()).await?;
            output.write_all(b"\n").await?;
            output.flush().await
        })
        .await??;
        Ok(output)
    });
    Lines::new(outgoing, incoming)
}

#[derive(Clone)]
pub(crate) struct Peer {
    pub connection: V2ConnectionTo<Client>,
    pub stop: CancellationToken,
}
impl Peer {
    pub async fn update(&self, session: &str, update: acp::SessionUpdate) -> Result<(), Error> {
        if self.stop.is_cancelled() {
            return Err("ACP connection closed".into());
        }
        self.connection
            .send_notification(acp::UpdateSessionNotification::new(session, update))?;
        Ok(())
    }
    pub async fn request(
        &self,
        callback: Callback,
        cancel: &CancellationToken,
    ) -> Result<Response, Error> {
        tokio::select! {
            _ = self.stop.cancelled() => Err("ACP connection closed".into()),
            _ = cancel.cancelled() => Err("ACP interaction cancelled".into()),
            result = tokio::time::timeout(Duration::from_secs(300), async {
                Ok::<_, Error>(match callback {
                    Callback::Permission(request) => Response::Permission(self.connection.send_request(request).block_task().await?),
                    Callback::Elicitation(request) => Response::Elicitation(self.connection.send_request(request).block_task().await?),
                })
            }) => result?,
        }
    }
}

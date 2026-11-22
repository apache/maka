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

use super::RootId;
use clap::Args;
use maka_event_log::root::RootNamespaces;
use maka_host_runtime::{
    HostError,
    logs::{HostLogCursor, HostLogPosition, HostLogRequest, Source},
};
use std::{io::Write, sync::Arc};
use tokio::{io::AsyncWriteExt, sync::Mutex};
use tokio_util::sync::CancellationToken;

#[derive(Args)]
pub(crate) struct Logs {
    #[arg(long)]
    root_id: RootId,
    #[arg(long)]
    pub(crate) follow: bool,
    #[arg(long)]
    after: Option<HostLogCursor>,
}

impl Logs {
    pub async fn run(self) -> Result<(), HostError> {
        let source = Source::for_root(&self.root_id.0, &RootNamespaces::for_current_account()?)?;
        let request = HostLogRequest {
            position: match self.after {
                Some(cursor) => HostLogPosition::After { cursor },
                None => HostLogPosition::Tail,
            },
        };
        if self.follow {
            let cancel = CancellationToken::new();
            let _signals = crate::signals::watch(cancel.clone())?;
            let output =
                maka_transport::stdio::Output::open("host-logs-stdout", std::io::stdout())?;
            let writer = Arc::new(Mutex::new(output.writer));
            let result = source
                .watch(request, cancel.clone(), |page| {
                    let writer = writer.clone();
                    async move {
                        let mut bytes = serde_json::to_vec(&page)?;
                        bytes.push(b'\n');
                        writer.lock().await.write_all(&bytes).await
                    }
                })
                .await;
            // Source::watch selects cancellation while an emit is backpressured.
            // Its dropped future releases this last bounded writer; the stdio
            // thread owns no Root lease and need not drain a full pipe on cancel.
            drop(writer);
            result?;
            if !cancel.is_cancelled() {
                tokio::select! {
                    _ = cancel.cancelled() => {},
                    done = output.done => done.map_err(std::io::Error::other)??,
                }
            }
        } else {
            let page = source.read(request).await?;
            let mut stdout = std::io::stdout().lock();
            serde_json::to_writer(&mut stdout, &page)?;
            stdout.write_all(b"\n")?;
            stdout.flush()?;
        }
        Ok(())
    }
}

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

use clap::Args;
use maka_host_runtime::application::host::startup::{Ready, Request};
use maka_host_runtime::{
    HostError,
    application::{host::discovery, transport::wire},
};
use std::path::PathBuf;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

/// Internal startup coordination for trusted TUI/Desktop launchers.
#[derive(Args)]
pub(crate) struct Ensure {
    /// Reopen or initialize a business Root without an authored application selection.
    #[arg(long)]
    root: Option<PathBuf>,
}
impl Ensure {
    pub(crate) async fn run(self) -> Result<(), HostError> {
        let maka_transport::stdio::Stdio {
            input,
            mut output,
            output_done,
        } = maka_transport::stdio::Stdio::open()?;
        let mut input = wire::Reader::new(input);
        let request: Option<Request> = if self.root.is_some() {
            None
        } else {
            let request: Request =
                tokio::time::timeout(Duration::from_secs(5), input.read()).await??;
            request.validate()?;
            Some(request)
        };
        let root = match (&self.root, &request) {
            (Some(root), None) if root.is_absolute() => root,
            (None, Some(request)) => &request.root,
            _ => return Err("local Host startup root must be absolute".into()),
        };
        let stop = CancellationToken::new();
        let _signals = crate::signals::watch(stop.clone())?;
        let client = tokio::select! {
            result = async {
                match &request {
                    Some(request) => crate::deployment::connect_application(request).await,
                    None => crate::deployment::connect_local(root.clone()).await,
                }
            } => result?,
            _ = stop.cancelled() => return Ok(()),
            byte = input.inner.read_u8() => {
                if byte.is_ok() { return Err("unexpected Host startup owner input".into()); }
                return Ok(());
            }
        };
        let registered = discovery::read(root)?;
        if request
            .as_ref()
            .is_some_and(|request| registered.source.deployment != request.deployment)
            || registered.host_epoch != client.epoch()
            || &registered.source != client.source()
        {
            return Err("application Host changed during startup admission".into());
        }
        registered.verify(
            &maka_host_runtime::application::host::Client::status(
                &registered.endpoint,
                Some(client.epoch()),
            )
            .await?,
        )?;
        wire::write_bounded(
            &mut output,
            &Ready {
                root_id: registered.root_id,
                epoch: client.epoch(),
            },
            4096,
        )
        .await?;
        tokio::select! {
            _ = stop.cancelled() => {},
            byte = input.inner.read_u8() => {
                if byte.is_ok() { return Err("unexpected Host startup owner input".into()); }
            }
        }
        // This probe owns no UI operation or Root; EOF releases only residency.
        drop(client);
        drop(output);
        tokio::time::timeout(Duration::from_secs(5), output_done).await???;
        Ok(())
    }
}

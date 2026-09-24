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

use clap::Args as ClapArgs;
use maka_event_log::root::RootNamespaces;
use maka_runtime_host::server::HostError;
use std::{path::PathBuf, time::Duration};
use tokio_util::sync::CancellationToken;

#[derive(ClapArgs)]
pub(crate) struct Args {
    /// Native State Root. Defaults to the same account root as the interactive client.
    #[arg(long, value_name = "DIRECTORY")]
    root: Option<PathBuf>,
}
pub(crate) async fn run(args: Args) -> Result<(), HostError> {
    let stop = CancellationToken::new();
    let _signals = crate::signals::watch(stop.clone())?;
    let stdio = crate::stdio::Stdio::open()?;
    let root = match args.root {
        Some(root) => root,
        None => RootNamespaces::for_current_account()?
            .ownership
            .parent()
            .ok_or("Missing account data directory")?
            .join("runtime-host-rust"),
    };
    let (client, notifications) = crate::deployment::connect_local(root).await?;
    let result = maka_acp::serve(client, notifications, stdio.input, stdio.output, stop).await;
    tokio::time::timeout(Duration::from_secs(5), stdio.output_done).await???;
    result
}

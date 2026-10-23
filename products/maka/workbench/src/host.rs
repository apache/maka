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

//! Admits a shell's connection to its Host.

use maka_app_client::{Client, Journal};
use maka_event_log::root;
use maka_host_runtime::application::host::Client as HostClient;
use maka_plugin_core::operation::receipt_reader_contract;
use std::path::{Path, PathBuf};

/// Checks that `host` serves the Root at `root` and the receipts contract the
/// workbench reads, and opens the shell's journal, `<root>/clients/<shell>.sqlite`.
/// Returns the workbench's client and the clients directory, where the shell
/// keeps its data. `host` is closed when admission fails.
pub async fn admit(
    mut host: HostClient,
    root: &Path,
    shell: &str,
) -> Result<(Client, PathBuf), String> {
    let prepare = async {
        let location = root::resolve(root).map_err(|error| error.to_string())?;
        if host.source().state_domain != location.root_id() {
            return Err(format!(
                "application Host changed during {shell} startup admission"
            ));
        }
        if host.catalogue().describe("receipts")?.contract != receipt_reader_contract() {
            return Err("Host receipts endpoint has a different contract".into());
        }
        let directory = location.canonical_path().join("clients");
        root::private_directory(&directory).map_err(|error| error.to_string())?;
        let journal = Journal::open(&directory.join(format!("{shell}.sqlite"))).await?;
        Ok((journal, directory))
    }
    .await;
    match prepare {
        Ok((journal, directory)) => Ok((Client::new(host, journal, "receipts".into())?, directory)),
        Err(error) => match host.close().await {
            Ok(()) => Err(error),
            Err(cleanup) => Err(format!("{error}; {shell} Host cleanup: {cleanup}")),
        },
    }
}

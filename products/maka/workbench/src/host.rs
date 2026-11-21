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
    host: HostClient,
    root: &Path,
    shell: &str,
) -> Result<(Client, PathBuf), String> {
    let prepare = async {
        let location = root::resolve(root).map_err(|error| error.to_string())?;
        let directory = location.canonical_path().join("clients");
        finish_admission(&host, location.root_id(), directory, shell).await
    }
    .await;
    finalize_or_close(host, shell, prepare).await
}

/// Admits a remote `host` connection without local Root filesystem access.
/// Verifies that `host` serves `expected_root_id` and the receipts contract
/// the workbench reads, and opens the shell's local journal at
/// `<client_data_dir>/<shell>.sqlite`. `host` is closed when admission fails.
pub async fn admit_remote(
    host: HostClient,
    expected_root_id: &str,
    client_data_dir: &Path,
    shell: &str,
) -> Result<(Client, PathBuf), String> {
    let prepare = finish_admission(
        &host,
        expected_root_id,
        client_data_dir.to_path_buf(),
        shell,
    )
    .await;
    finalize_or_close(host, shell, prepare).await
}

async fn finish_admission(
    host: &HostClient,
    expected_root_id: &str,
    directory: PathBuf,
    shell: &str,
) -> Result<(Journal, PathBuf), String> {
    if expected_root_id.trim().is_empty() {
        return Err("expected Root id must not be empty".into());
    }
    if host.source().state_domain != expected_root_id {
        return Err(format!(
            "application Host changed during {shell} startup admission"
        ));
    }
    if host.catalogue().describe("receipts")?.contract != receipt_reader_contract() {
        return Err("Host receipts endpoint has a different contract".into());
    }
    root::private_directory(&directory).map_err(|error| error.to_string())?;
    let journal = Journal::open(&directory.join(format!("{shell}.sqlite"))).await?;
    Ok((journal, directory))
}

async fn finalize_or_close(
    mut host: HostClient,
    shell: &str,
    prepare: Result<(Journal, PathBuf), String>,
) -> Result<(Client, PathBuf), String> {
    match prepare {
        Ok((journal, directory)) => Ok((Client::new(host, journal, "receipts".into())?, directory)),
        Err(error) => match host.close().await {
            Ok(()) => Err(error),
            Err(cleanup) => Err(format!("{error}; {shell} Host cleanup: {cleanup}")),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_host_runtime::application::{
        host::OpenChannel,
        transport::{Catalogue, Description, wire},
    };
    use maka_plugin_core::{
        composition::InstanceId,
        contract::Contract,
        deployment::DeploymentRef,
    };
    use serde_json::{Value, json};
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    use tempfile::TempDir;
    use uuid::Uuid;

    async fn mock_host_client(
        state_domain: &str,
        receipts_contract: Contract,
    ) -> (HostClient, Arc<AtomicBool>) {
        let closed = Arc::new(AtomicBool::new(false));
        let closed_for_server = closed.clone();
        let state_domain = state_domain.to_owned();
        let epoch = Uuid::from_u128(0x1111);
        let session = Uuid::from_u128(0x2222);
        let provider: InstanceId = serde_json::from_value(json!([Uuid::from_u128(1)])).unwrap();
        let description = Description {
            provider: provider.clone(),
            export: "receipts".into(),
            contract: receipts_contract,
            registration_epoch: Some(Uuid::from_u128(0x3333)),
        };
        let catalogue: Catalogue = serde_json::from_value(json!({
            "endpoints": {
                "receipts": description
            }
        }))
        .unwrap();

        let open: OpenChannel = Arc::new(move || {
            let state_domain = state_domain.clone();
            let catalogue = catalogue.clone();
            let provider = provider.clone();
            let closed_for_server = closed_for_server.clone();
            Box::pin(async move {
                let (client_io, mut server_io) = tokio::io::duplex(64 * 1024);
                tokio::spawn(async move {
                    let mut reader = wire::Reader::new(&mut server_io);
                    let _opening: Value = match reader.read().await {
                        Ok(value) => value,
                        Err(_) => return,
                    };
                    let source = DeploymentRef {
                        state_domain,
                        deployment: Uuid::from_u128(2),
                        revision: 1,
                    };
                    let response = json!({
                        "kind": "connected",
                        "value": {
                            "version": 1,
                            "epoch": epoch,
                            "session": session,
                            "source": source,
                            "consumers": {
                                "receipts": provider
                            },
                            "catalogue": catalogue,
                            "ui": null
                        }
                    });
                    if wire::write(&mut reader.inner, &response).await.is_err() {
                        return;
                    }
                    if let Ok(control) = reader.read::<Value>().await
                        && control["kind"] == "close"
                    {
                        closed_for_server.store(true, Ordering::SeqCst);
                        let _ = wire::write(&mut reader.inner, &json!({ "kind": "closed" })).await;
                    }
                });
                Ok(Box::new(client_io) as _)
            })
        });

        let client = HostClient::connect_on(open, Some(epoch), Some(Arc::from("ios-test")))
            .await
            .unwrap();
        (client, closed)
    }

    #[tokio::test]
    async fn admit_remote_opens_journal_in_client_data_dir_when_root_and_contract_match() {
        let temp = TempDir::new().unwrap();
        let root_alpha = "a".repeat(64);
        let data_dir = temp.path().join("remote-host-a");
        let (host, closed) = mock_host_client(&root_alpha, receipt_reader_contract()).await;

        let (client, directory) = admit_remote(host, &root_alpha, &data_dir, "ios")
            .await
            .expect("remote admission should succeed");
        assert_eq!(directory, data_dir);
        assert!(data_dir.join("ios.sqlite").is_file());
        assert!(!closed.load(Ordering::SeqCst));

        client.close().await.unwrap();
        assert!(closed.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn admit_remote_rejects_mismatched_or_empty_root_id_and_closes_host() {
        let temp = TempDir::new().unwrap();
        let root_alpha = "a".repeat(64);
        let root_beta = "b".repeat(64);
        let (host_empty, closed_empty) =
            mock_host_client(&root_alpha, receipt_reader_contract()).await;
        let err_empty = match admit_remote(host_empty, "   ", temp.path(), "ios").await {
            Ok(_) => panic!("empty root id must fail"),
            Err(err) => err,
        };
        assert_eq!(err_empty, "expected Root id must not be empty");
        assert!(closed_empty.load(Ordering::SeqCst));

        let (host_mismatch, closed_mismatch) =
            mock_host_client(&root_alpha, receipt_reader_contract()).await;
        let err_mismatch =
            match admit_remote(host_mismatch, &root_beta, temp.path(), "ios").await {
                Ok(_) => panic!("mismatched root id must fail"),
                Err(err) => err,
            };
        assert_eq!(
            err_mismatch,
            "application Host changed during ios startup admission"
        );
        assert!(closed_mismatch.load(Ordering::SeqCst));
        assert!(!temp.path().join("ios.sqlite").exists());
    }
}

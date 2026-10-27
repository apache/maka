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

use super::provider::{ModelRequest, Provider};
use agent_client_protocol::schema::v2 as acp;
use maka_event_log::root::{RootNamespaces, RootOwner};
use maka_host_runtime::{
    application::{host::Client as Native, transport::wire::Reply},
    ipc::LocalListener,
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::PathBuf};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
pub fn catalog_transport() -> std::sync::Arc<dyn maka_agent_ports::model::Transport> {
    struct Unavailable;
    impl maka_agent_ports::model::Transport for Unavailable {
        fn identity(&self) -> u64 {
            0
        }
        fn request(
            &self,
            _: maka_capabilities::http::Request,
            _: tokio_util::sync::CancellationToken,
        ) -> futures_util::future::BoxFuture<
            '_,
            Result<maka_capabilities::http::Response, maka_agent_ports::model::Error>,
        > {
            Box::pin(async {
                Err(maka_agent_ports::model::Error::Adapter(
                    "public catalog network is not part of this fixture".into(),
                ))
            })
        }
        fn connect(
            &self,
            _: maka_agent_ports::model::Connect,
        ) -> futures_util::future::BoxFuture<
            '_,
            Result<
                std::sync::Arc<dyn maka_agent_ports::model::Socket>,
                maka_agent_ports::model::Error,
            >,
        > {
            Box::pin(async {
                Err(maka_agent_ports::model::Error::Adapter(
                    "public catalog does not use WebSockets".into(),
                ))
            })
        }
    }
    std::sync::Arc::new(Unavailable)
}

pub struct Fixture {
    pub _root: tempfile::TempDir,
    pub workspace: PathBuf,
    pub database: PathBuf,
    pub session: String,
    pub endpoint: PathBuf,
    pub epoch: uuid::Uuid,
    pub provider: Provider,
    pub model_requests: mpsc::Receiver<ModelRequest>,
    pub client: Native,
    pub native: Native,
    pub stop: CancellationToken,
    pub _cleanup: tokio_util::sync::DropGuard,
    pub server: tokio::task::JoinHandle<Result<(), String>>,
}
impl Fixture {
    pub async fn runtime_databases(&self) -> Vec<PathBuf> {
        let mut entries =
            tokio::fs::read_dir(self.database.parent().unwrap().join("runtime-partitions"))
                .await
                .unwrap();
        let mut paths = Vec::new();
        while let Some(entry) = entries.next_entry().await.unwrap() {
            let path = entry.path();
            if path
                .extension()
                .is_some_and(|extension| extension == "sqlite")
                && entry.file_type().await.unwrap().is_file()
            {
                paths.push(path);
            }
        }
        assert!(!paths.is_empty(), "fixture must have runtime databases");
        paths
    }

    pub async fn database_containing(&self, query: &'static str, parameters: &[&str]) -> PathBuf {
        use sqlx::Connection;
        let mut matches = Vec::new();
        for path in self.runtime_databases().await {
            let mut connection = sqlx::SqliteConnection::connect_with(
                &sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(&path)
                    .read_only(true),
            )
            .await
            .unwrap();
            let mut query = sqlx::query_scalar::<_, bool>(query);
            for parameter in parameters {
                query = query.bind(*parameter);
            }
            if query.fetch_one(&mut connection).await.unwrap() {
                matches.push(path);
            }
            connection.close().await.unwrap();
        }
        assert_eq!(
            matches.len(),
            1,
            "expected one authoritative runtime database"
        );
        matches.pop().unwrap()
    }

    pub async fn intent_count(&self) -> i64 {
        use sqlx::Connection;
        let mut connection = sqlx::SqliteConnection::connect_with(
            &sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&self.database)
                .read_only(true),
        )
        .await
        .unwrap();
        let count = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM application_intents")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        connection.close().await.unwrap();
        count
    }
    pub async fn open() -> Self {
        let directory = tempfile::tempdir().unwrap();
        maka_event_log::root::private_directory(directory.path()).unwrap();
        let namespaces = RootNamespaces {
            ownership: directory.path().join("owners"),
            control: directory.path().join("control"),
        };
        let root = directory.path().join("root");
        let workspace = directory.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let workspace = workspace.canonicalize().unwrap();
        let (provider, model_requests) = Provider::controlled().await;
        super::provider::configure(
            RootOwner::create(&root, &namespaces).unwrap(),
            &provider.base_url,
        )
        .await;
        let mut product = crate::application::open_host(
            RootOwner::open(&root, &namespaces).unwrap(),
            Default::default(),
            crate::application::Roots::Configured(Some(vec![
                maka_host_runtime::DirectoryRootSpec {
                    label: "Test".into(),
                    path: workspace.to_str().unwrap().into(),
                },
            ])),
            Some(catalog_transport()),
        )
        .await
        .unwrap();
        #[cfg(unix)]
        let endpoint = directory.path().join("host.sock");
        #[cfg(windows)]
        let endpoint = PathBuf::from(format!(r"\\.\pipe\maka-acp-{}", uuid::Uuid::new_v4()));
        let listener = LocalListener::bind(&endpoint).unwrap();
        let epoch = product.host.epoch();
        let stop = CancellationToken::new();
        let server = tokio::spawn({
            let stop = stop.clone();
            async move {
                let result = product.host.serve_local(listener, stop).await;
                let cleanup = product.shutdown().await.map_err(|error| error.to_string());
                result.and(cleanup)
            }
        });
        let native = Native::connect(&endpoint, Some(epoch)).await.unwrap();
        assert!(
            native
                .catalogue()
                .describe("agent")
                .unwrap()
                .registration_epoch
                .is_some(),
            "public Agent fixture failed to activate: {:?}",
            native.catalogue().startup_error(),
        );
        let roots = query(&native, "agent", "directories", json!({"kind":"roots"})).await;
        let created = mutate(&native, "agent", "create", json!({"title":"SDK session","labels":[],"workspace":{"kind":"directory","selection":roots["roots"][0]["selection"]}})).await;
        let session = created["session"]["id"].as_str().unwrap().to_owned();
        let client = Native::connect(&endpoint, Some(epoch)).await.unwrap();
        Self {
            _root: directory,
            workspace,
            database: root.join(maka_event_log::root::ROOT_DATABASE),
            session,
            endpoint,
            epoch,
            provider,
            model_requests,
            client,
            native,
            _cleanup: stop.clone().drop_guard(),
            stop,
            server,
        }
    }
}
pub async fn until_idle(
    receive: &mut mpsc::Receiver<acp::SessionUpdate>,
    updates: &mut Vec<acp::SessionUpdate>,
) -> Option<acp::StopReason> {
    loop {
        let update = receive
            .recv()
            .await
            .expect("SDK update stream closed before idle");
        let idle = match &update {
            acp::SessionUpdate::StateUpdate(acp::StateUpdate::Idle(idle)) => {
                Some(idle.stop_reason.clone())
            }
            _ => None,
        };
        updates.push(update);
        if let Some(reason) = idle {
            return reason;
        }
    }
}

pub async fn query(client: &Native, endpoint: &str, method: &str, input: Value) -> Value {
    let mut call = client
        .call(endpoint, method.into(), input, Default::default())
        .await
        .unwrap();
    call.start().await.unwrap();
    let Reply::Finished { result, cleanup } = call.receive().await.unwrap() else {
        panic!("query result")
    };
    cleanup.unwrap();
    result.unwrap()
}
pub async fn mutate(client: &Native, endpoint: &str, method: &str, input: Value) -> Value {
    let mut call = client
        .call(endpoint, method.into(), input, Default::default())
        .await
        .unwrap();
    call.start().await.unwrap();
    assert!(matches!(
        call.receive().await.unwrap(),
        Reply::Prepared { .. }
    ));
    let Reply::Mutation { reply, cleanup } = call.confirm().await.unwrap() else {
        panic!("mutation receipt")
    };
    cleanup.unwrap();
    let maka_plugin_core::operation::Receipt::Recorded {
        outcome: maka_plugin_core::operation::OperationOutcome::Returned { value },
        cleanup: maka_plugin_core::operation::OperationCleanup::Confirmed,
    } = reply.receipt
    else {
        panic!("recorded result")
    };
    value
}
pub async fn canonical(
    client: &Native,
    session: &str,
) -> Vec<maka_agent_api::contract::HistoryChunk> {
    let mut through = None;
    let mut position = json!({"kind":"start"});
    let mut history = Vec::new();
    for _ in 0..64 {
        let page = query(client, "agent", "history", json!({"sessionId":session,"through":through,"position":position,"includeThinking":true})).await;
        let maka_agent_api::contract::HistoryPage::Ready {
            through: fence,
            chunks,
            after,
            ..
        } = serde_json::from_value(page).unwrap();
        if let Some(through) = through {
            assert_eq!(fence, through);
        }
        through = Some(fence);
        history.extend(chunks);
        let Some(cursor) = after else {
            return history;
        };
        position = json!({"kind":"after","cursor":cursor});
    }
    panic!("fixture history did not reach its original fence")
}

/// Apply the SDK's append/replacement contract, so replay is compared by actual
/// displayed message content and identity rather than notification counts.
pub fn messages(updates: &[acp::SessionUpdate]) -> BTreeMap<(String, String), String> {
    let mut messages = BTreeMap::<(String, String), String>::new();
    for update in updates {
        let value = serde_json::to_value(update).unwrap();
        let Some(id) = value["messageId"].as_str() else {
            continue;
        };
        let kind = value["sessionUpdate"].as_str().unwrap();
        let entry = messages
            .entry((kind.trim_end_matches("_chunk").into(), id.into()))
            .or_default();
        if kind.ends_with("_chunk") {
            entry.push_str(value["content"]["text"].as_str().expect("text fixture"));
        } else {
            *entry = value["content"]
                .as_array()
                .unwrap()
                .iter()
                .map(|block| block["text"].as_str().expect("text fixture"))
                .collect();
        }
    }
    messages
}

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

use maka_config::ConfigurationStore;
use maka_event_log::{
    EventLog,
    root::{RootNamespaces, RootOwner},
};
use maka_protocol::session::SandboxMode;
use maka_runtime::configuration::*;
use maka_runtime_host::server::Host;
use maka_runtime_host::session::{PreparedSession, SessionModel};
use serde_json::json;
use std::{os::unix::fs::PermissionsExt, path::PathBuf, sync::Arc};

pub async fn fixture() -> (
    tempfile::TempDir,
    RootNamespaces,
    PathBuf,
    std::net::TcpListener,
    Arc<Host>,
) {
    let directory = tempfile::Builder::new()
        .prefix("maka-execution-")
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir_in("/tmp")
        .unwrap();
    let ns = RootNamespaces {
        ownership: directory.path().join("owners"),
        control: directory.path().join("control"),
    };
    let root = directory.path().join("root");
    let provider = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    provider.set_nonblocking(true).unwrap();
    let base_url = format!("http://{}/v1", provider.local_addr().unwrap());
    let owner = Arc::new(RootOwner::create(&root, &ns).unwrap());
    let configuration = Arc::new(ConfigurationStore::for_root(owner.clone()).await.unwrap());
    let login = configuration.prepare_oauth_login(serde_json::from_value(json!({
        "attemptId":"fixture-login",
        "target":{"kind":"create","slug":"fixture","name":"Fixture",
            "provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"openai-compatible"},
            "configuration":{"baseUrl":base_url}},
        "authentication":{"method":"api-key","input":{"apiKey":"fixture-secret"}}
    })).unwrap()).await.unwrap();
    let maka_config::oauth::enrollment::LoginPreparation::Ready(login) = login else {
        panic!("fixture login");
    };
    assert!(login.claim().await.unwrap());
    assert!(matches!(
        login
            .complete(
                maka_runtime::provider::Credential {
                    secret: "fixture-secret".into(),
                    refresh_at: None,
                },
                1
            )
            .await
            .unwrap(),
        maka_config::oauth::enrollment::LoginCompletion::Committed(_)
    ));
    let row = login.connection();
    let created = configuration.update_connection(serde_json::from_value(json!({
        "expected":{"connectionId":row.connection_id,"revision":row.revision},
        "changes":{"name":row.name,"configuration":row.configuration,"enabled":true,"enabledModelIds":["fixture-model"],"modelOverrides":{"fixture-model":{"contextWindow":200000}}}
    })).unwrap()).await.unwrap();
    let CatalogMutationResult::Committed {
        connection: Some(connection),
        ..
    } = created
    else {
        panic!("connection must be committed");
    };
    let log = EventLog::for_root(owner.clone()).await.unwrap();
    let prepared = PreparedSession::new(
        serde_json::from_value(json!({
            "sessionId":"session","workspace":{"kind":"host_path","path":"/tmp"},
            "modelTarget":{"kind":"default"}
        }))
        .unwrap(),
    )
    .unwrap();
    let session = prepared.bind(
        maka_protocol::session::WorkspaceProjection {
            target: maka_protocol::session::WorkspaceTarget::HostPath {
                path: "/tmp".into(),
            },
            host_cwd: "/tmp".into(),
        },
        SessionModel {
            connection_id: connection.connection_id,
            connection_slug: "fixture".into(),
            model: "fixture-model".into(),
        },
        SandboxMode::ReadOnly,
    );
    log.create_session("session", "fingerprint", &session, 1)
        .await
        .unwrap();
    log.shutdown().await.unwrap();
    configuration.shutdown().await.unwrap();
    drop(login);
    drop(configuration);
    drop(log);
    drop(owner);
    let host = Host::open(RootOwner::open(&root, &ns).unwrap())
        .await
        .unwrap();
    let mut peer = super::peer::Peer::new(host.clone(), "fixture-startup").await;
    peer.wait_for_plugins().await;
    peer.close().await;

    (directory, ns, root, provider, host)
}

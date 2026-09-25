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

use maka_event_log::root::{RootNamespaces, RootOwner};
use maka_runtime_host::server::{Host, HostError, HostOptions, Registration, local::LocalListener};
use std::{fs, io::Write, os::unix::fs::PermissionsExt, path::Path, time::Duration};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

pub(super) async fn serve(
    root: &Path,
    user_library: &Path,
    stop: CancellationToken,
) -> (JoinHandle<Result<(), HostError>>, Registration) {
    let owner = RootOwner::open(root, &RootNamespaces::for_current_account().unwrap()).unwrap();
    // The import target must be temporary; never inherit or replace HOME.
    let service = Host::open_with_options(
        owner,
        None,
        HostOptions {
            skill_home: Some(user_library.to_owned()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let socket = root.parent().unwrap().join("host.sock");
    let listener = LocalListener::bind(&socket).unwrap();
    let registration = service.publish_registration(&socket, None).unwrap();
    (tokio::spawn(listener.serve(service, stop)), registration)
}

/// Run the compiled integration binary with this exact ignored test and
/// --nocapture. The owner opens the printed root in a frozen TUI binary, then
/// writes one newline here after closing that TUI. No detached daemon is used.
#[test]
#[ignore = "interactive isolated Host for manual terminal acceptance"]
fn manual_smoke_host() {
    let directory = tempfile::Builder::new()
        .prefix("maka-skills-manual-")
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir()
        .unwrap();
    let workspace = directory.path().join("workspace");
    let user_library = directory.path().join("user-library");
    fs::create_dir_all(&workspace).unwrap();
    fs::create_dir_all(&user_library).unwrap();
    let import = workspace.join("review.md");
    fs::write(&import, super::document("Original manual instructions")).unwrap();
    fs::write(workspace.join("notes.txt"), b"sibling is not imported").unwrap();
    let host = crate::candidate::CandidateFixture::new(directory.path().join("root"));
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let stop = CancellationToken::new();
    let _cleanup = stop.clone().drop_guard();
    let (server, registration, client, provider) = runtime.block_on(async {
        let (server, registration) = serve(&host.root, &user_library, stop.clone()).await;
        let provider = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = super::support::model_client(&host.root, &format!("http://{}/v1", provider.local_addr().unwrap())).await;
        client.create_session(maka_protocol::session::decode_session_create_input(&serde_json::json!({
            "sessionId":"skill-library", "name":"Library session", "workspace":{"kind":"host_path","path":workspace},
            "sandboxMode":"read-only", "modelTarget":{"kind":"default"}
        })).unwrap()).await.unwrap();
        (server, registration, client, provider)
    });
    println!(
        "{}",
        serde_json::json!({
            "root":host.root, "workspace":workspace, "import":import, "userLibrary":user_library,
            "tuiStateDirectory":directory.path().join("tui-state"), "stop":"Close the TUI, then press Enter here"
        })
    );
    std::io::stdout().flush().unwrap();
    let mut input = String::new();
    std::io::stdin().read_line(&mut input).unwrap();
    runtime.block_on(async {
        assert!(
            tokio::time::timeout(Duration::from_millis(50), provider.accept())
                .await
                .is_err(),
            "manual library actions must not call a model"
        );
    });
    client.disconnect();
    stop.cancel();
    runtime
        .block_on(async { tokio::time::timeout(Duration::from_secs(10), server).await })
        .unwrap()
        .unwrap()
        .unwrap();
    registration.remove().unwrap();
}

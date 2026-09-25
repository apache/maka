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

use super::*;
use maka_plugins::{authorization::Grant, composition::Scope, remote::Target as Backend};
use maka_protocol::plugin::{Query, QueryResult, View};
use maka_runtime_host::server::HostOptions;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_consent_distinguishes_session_context_from_the_resolved_backend_scope() {
    tokio::time::timeout(Duration::from_secs(30), scenario())
        .await
        .unwrap();
}
async fn scenario() {
    let fixture = ClientFixture::new("maka-native-consent-scope-");
    let model =
        crate::support::message_recovery::configure(&fixture, "http://127.0.0.1:1/v1").await;
    let user_home = fixture.workspace.join("user-home");
    let directory = fixture.workspace.join("approved-directory");
    std::fs::create_dir_all(&user_home).unwrap();
    std::fs::create_dir_all(&directory).unwrap();
    let host = Host::open_with_options(
        fixture.owner(),
        None,
        HostOptions {
            skill_home: Some(user_home),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    #[cfg(unix)]
    let endpoint = fixture
        .workspace
        .parent()
        .unwrap()
        .join("consent-scope.sock");
    #[cfg(windows)]
    let endpoint = std::path::PathBuf::from(format!(
        r"\\.\pipe\maka-consent-scope-{}",
        uuid::Uuid::new_v4()
    ));
    let stop = CancellationToken::new();
    let cleanup = stop.clone().drop_guard();
    let server = tokio::spawn(
        LocalListener::bind(&endpoint)
            .unwrap()
            .serve(host.clone(), stop.clone()),
    );
    let (mut peer, hello) = Peer::handshake(host.clone(), "consent-scope-admin").await;
    settled(&mut peer, "initial plugins").await;
    for session in ["scope-one", "scope-two"] {
        success(peer.rpc("session.create", json!({
            "sessionId":session,"workspace":{"kind":"host_path","path":fixture.workspace},
            "sandboxMode":"read-only","modelTarget":{"kind":"explicit","connectionId":model.connection_id,"connectionSlug":model.connection_slug,"model":model.model}
        })).await);
    }
    // Session Web owns a private client-support service; its scoped remote
    // endpoint still shadows the inherited Profile endpoint normally.
    success(peer.rpc("plugin.composition.apply", json!({"operations":[{
        "type":"insert","rootId":"session:scope-one","entry":{"id":"consent-session-web","packageId":"maka.web","isolate":{"maka.web.client":true}}
    }]})).await);
    settled(&mut peer, "Session Web composition").await;
    let (client, mut notices) = Client::connect(
        maka_client::local::open_stream(&endpoint).await.unwrap(),
        host.root_id(),
        hello["hostEpoch"].as_str().unwrap(),
        Operations,
    )
    .await
    .unwrap();
    let notifications = tokio::spawn(async move { while notices.recv().await.is_some() {} });

    eprintln!("native consent scope: Client connected; checking Profile approval");
    let profile = binding("maka.skills", "terminal-library", Some("scope-one"));
    let profile_backend = bound(&client, &profile, Scope::Profile).await;
    let directory_target = Target::Directory {
        path: directory.to_str().unwrap().into(),
    };
    let directory_proposal = proposal(directory_target.clone(), Capability::ReadFiles);
    let directory_approval = input(
        &profile,
        &profile_backend,
        AuthorizationCommand::Approve {
            request: directory_proposal.clone(),
        },
    );
    let original = grant(&client, directory_approval.clone()).await;
    assert_eq!(original.request, directory_proposal);
    assert!(!original.revoked);
    assert_eq!(
        grant(&client, directory_approval).await,
        original,
        "same operation returns its original grant"
    );
    let query = input(
        &profile,
        &profile_backend,
        AuthorizationCommand::Query { id: original.id },
    );
    assert_eq!(grant(&client, query).await, original);

    let session = binding("maka.web", "terminal", Some("scope-one"));
    let session_backend = bound(&client, &session, Scope::Session("scope-one".into())).await;
    assert_eq!(session_backend.entry_id, "consent-session-web");
    // Context changes cannot carry the original Session registration elsewhere.
    let targets = [
        (directory_target.clone(), Capability::ReadFiles),
        (Target::Profile, Capability::Notifications),
        (
            Target::Session {
                session_id: "scope-two".into(),
            },
            Capability::Notifications,
        ),
    ];
    for context in [Some("scope-one"), None, Some("scope-two")] {
        let discovered = binding("maka.web", "terminal", context);
        for (target, capability) in &targets {
            let request = approval(&discovered, &session_backend, target.clone(), *capability);
            if context == Some("scope-one")
                && matches!(target, Target::Session { session_id } if session_id == "scope-two")
            {
                // This input is structurally invalid, not an admissible RPC that
                // can return an authorization denial on the shared connection.
                let error = client.plugin_authorization(request).await.unwrap_err();
                assert!(
                    matches!(
                        &error,
                        maka_client::RequestFailure::NotDispatched(
                            maka_client::ClientError::Protocol(_)
                        )
                    ),
                    "{error:?}"
                );
                continue;
            }
            let code = if context == Some("scope-one") {
                "unauthorized"
            } else {
                "operation_conflict"
            };
            denied(&mut peer, request, code).await;
        }
    }
    let inherited = binding("maka.web", "terminal", None);
    let inherited_backend = bound(&client, &inherited, Scope::Profile).await;
    assert_ne!(inherited_backend, session_backend);
    let mut forged_registration = session_backend.clone();
    forged_registration.registration = uuid::Uuid::new_v4();
    for backend in [&inherited_backend, &forged_registration] {
        let request = approval(
            &session,
            backend,
            directory_target.clone(),
            Capability::ReadFiles,
        );
        denied(&mut peer, request, "operation_conflict").await;
    }

    eprintln!("native consent scope: out-of-scope approvals rejected");
    let within = proposal(
        Target::Session {
            session_id: "scope-one".into(),
        },
        Capability::Notifications,
    );
    let accepted = grant(
        &client,
        input(
            &session,
            &session_backend,
            AuthorizationCommand::Approve {
                request: within.clone(),
            },
        ),
    )
    .await;
    assert_eq!(accepted.request, within);
    let query = input(
        &session,
        &session_backend,
        AuthorizationCommand::Query { id: accepted.id },
    );
    assert_eq!(grant(&client, query).await, accepted);
    // Grant lookup also remains in the actual backend namespace.
    let separate = client
        .plugin_authorization(input(
            &inherited,
            &inherited_backend,
            AuthorizationCommand::Query { id: accepted.id },
        ))
        .await
        .unwrap();
    assert!(matches!(
        separate,
        AuthorizationResult::Grant { grant: None }
    ));
    eprintln!("native consent scope: grants checked; closing Client");
    client.disconnect();
    tokio::time::timeout(Duration::from_secs(5), notifications)
        .await
        .expect("Client notice reader did not close")
        .unwrap();
    eprintln!("native consent scope: draining Host");
    success(
        peer.rpc(
            "host.upgrade.prepare",
            json!({"expectedHostEpoch":hello["hostEpoch"],"allowInterruptActiveTasks":false}),
        )
        .await,
    );
    peer.close().await;
    stop.cancel();
    server.await.unwrap().unwrap();
    cleanup.disarm();
}
fn binding(package: &str, method: &str, session: Option<&str>) -> RemoteBinding {
    RemoteBinding::Package {
        package_id: package.into(),
        method: method.into(),
        session_id: session.map(str::to_owned),
    }
}
fn proposal(target: Target, capability: Capability) -> Request {
    Request {
        operation_id: uuid::Uuid::new_v4(),
        title: "Inspect native consent scope".into(),
        target,
        capabilities: [capability].into(),
    }
}
fn input(
    binding: &RemoteBinding,
    backend: &Backend,
    command: AuthorizationCommand,
) -> AuthorizationInput {
    AuthorizationInput::Remote {
        binding: binding.clone(),
        target: backend.clone(),
        command,
    }
}
fn approval(
    binding: &RemoteBinding,
    backend: &Backend,
    target: Target,
    capability: Capability,
) -> AuthorizationInput {
    input(
        binding,
        backend,
        AuthorizationCommand::Approve {
            request: proposal(target, capability),
        },
    )
}
async fn bound(client: &Client, binding: &RemoteBinding, scope: Scope) -> Backend {
    let RemoteResult::Bound { target, .. } = client
        .plugin_remote(RemoteRequest::Bind {
            binding: binding.clone(),
        })
        .await
        .unwrap()
    else {
        panic!("bound backend");
    };
    let QueryResult::TerminalViews(page) = client
        .plugin_query(Query {
            view: View::TerminalViews,
            root_id: Some(scope.clone()),
            cursor: None,
            limit: None,
        })
        .await
        .unwrap()
    else {
        panic!("terminal inventory");
    };
    let published = page
        .items
        .iter()
        .find(|item| item.target == target)
        .expect("bound endpoint is published in its actual owner scope");
    assert_eq!(published.scope_id, scope);
    target
}
async fn grant(client: &Client, input: AuthorizationInput) -> Grant {
    let AuthorizationResult::Grant { grant: Some(grant) } =
        client.plugin_authorization(input).await.unwrap()
    else {
        panic!("durable grant");
    };
    grant
}
async fn denied(peer: &mut Peer, input: AuthorizationInput, code: &str) {
    // Only well-formed authority denials use this shared live connection.
    input
        .validate()
        .expect("malformed frames do not have ordinary RPC replies");
    // Bypass Client dispatch to prove that Host enforces owner isolation.
    let response = peer
        .rpc("plugin.authorization", serde_json::to_value(input).unwrap())
        .await;
    assert_eq!(response["ok"], false, "{response}");
    assert_eq!(response["error"]["code"], code, "{response}");
}

async fn settled(peer: &mut Peer, stage: &str) {
    eprintln!("native consent scope: waiting for {stage}");
    if tokio::time::timeout(Duration::from_secs(5), ready(peer))
        .await
        .is_err()
    {
        let failures = peer
            .rpc("plugin.platform.query", json!({"view":"failures"}))
            .await;
        let entries = peer
            .rpc(
                "plugin.platform.query",
                json!({"view":"entries","rootId":"session:scope-one"}),
            )
            .await;
        panic!("{stage} did not converge; failures={failures}; Session entries={entries}");
    }
    eprintln!("native consent scope: {stage} converged");
}

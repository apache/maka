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
use crate::local_fixture as support;
use maka_host_runtime::application::host::startup::{self, Request};
use maka_host_runtime::application::transport::{Grant, HostEndpoint, Reply};
use maka_plugin_core::operation::{OperationCleanup, OperationOutcome, OperationReply, Receipt};
use serde_json::json;
use std::{collections::BTreeMap, sync::Arc};
use uuid::Uuid;

async fn query(client: &Client, endpoint: &str, method: &str, input: Value) -> Value {
    let mut call = client
        .call(endpoint, method.into(), input, Default::default())
        .await
        .unwrap();
    call.start().await.unwrap();
    let reply = call.receive().await.unwrap();
    assert!(call.cleanup_confirmed());
    match reply {
        Reply::Finished {
            result: Ok(value),
            cleanup: Ok(()),
        } => value,
        other => panic!("query must complete with confirmed cleanup: {other:?}"),
    }
}

#[test]
fn root_startup_initializes_an_empty_root_reuses_its_host_and_preserves_another_client() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(60), async {
            assert!(!root.exists());
            // Bind cleanup first so accepted clients detach before it retires
            // this fresh Root, including when an assertion unwinds.
            let (fixture, mut first) = {
                let first = startup::connect_root(Path::new(env!("CARGO_BIN_EXE_maka")), &root)
                    .await
                    .unwrap();
                (CandidateFixture::adopt_existing(root.clone()), first)
            };
            let found = discovery::read(&root).unwrap();
            found
                .verify(
                    &Client::status(&found.endpoint, Some(first.epoch()))
                        .await
                        .unwrap(),
                )
                .unwrap();
            assert_eq!(first.source().state_domain, fixture.root_id);
            let list = json!({"filter":"all","position":{"kind":"start"}});
            let catalog = query(&first, "agent", "list", list.clone()).await;
            assert_eq!(catalog["sessions"], json!([]));
            assert_eq!(catalog["needsYouCount"], json!(0));
            assert_eq!(catalog.get("before"), Some(&Value::Null));
            assert_eq!(catalog.get("after"), Some(&Value::Null));

            let missing_helper = directory.path().join("never-created-startup-helper");
            let error = startup::connect_root(&missing_helper, &root)
                .await
                .err()
                .unwrap();
            assert!(error.starts_with("local Host startup helper:"), "{error}");
            let mut second = startup::connect_root(Path::new(env!("CARGO_BIN_EXE_maka")), &root)
                .await
                .unwrap();
            assert_eq!(second.epoch(), first.epoch());
            assert_eq!(second.source(), first.source());
            first.close().await.unwrap();
            assert_eq!(query(&second, "agent", "list", list).await, catalog);
            second.close().await.unwrap();

            let fresh = directory.path().join("must-not-be-created");
            let error = startup::connect_root(&missing_helper, &fresh)
                .await
                .err()
                .expect("missing trusted helper must fail instead of falling back to PATH");
            assert!(error.starts_with("local Host startup helper:"), "{error}");
            assert!(!fresh.exists());
            assert_eq!(
                startup::connect_root(&missing_helper, Path::new("relative-root"))
                    .await
                    .err()
                    .unwrap(),
                "local Host startup root must be absolute"
            );
        })
        .await
        .unwrap();
    });
}

#[test]
fn owned_startup_connects_concurrently_and_preserves_original_effect_and_last_client_lifetime() {
    let directory = tempfile::tempdir().unwrap();
    // The real CLI helper uses the current account's control namespace. This
    // fixture owns only a fresh random Root and cleans its exact registration.
    let fixture = CandidateFixture::new(directory.path().join("root"));
    let namespaces = RootNamespaces::for_current_account().unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(60), async {
            let store = maka_event_log::root_store::RootStore::open(Arc::new(
                RootOwner::open(&fixture.root, &namespaces).unwrap(),
            ))
            .await
            .unwrap();
            let deployment = Uuid::new_v4();
            let (input, packages) = support::host();
            let source = store
                .commit_application(deployment, 0, input, vec![], packages)
                .await
                .unwrap();
            store.close().await.unwrap();
            let endpoints = BTreeMap::from([
                (
                    "business".into(),
                    HostEndpoint {
                        consumer: support::identity(13),
                        import: "business".into(),
                        grant: Grant {
                            methods: ["read".into(), "write".into()].into(),
                            recovery: false,
                        },
                    },
                ),
                (
                    "receipts".into(),
                    HostEndpoint {
                        consumer: support::identity(13),
                        import: "receipts".into(),
                        grant: Grant {
                            methods: ["read".into()].into(),
                            recovery: true,
                        },
                    },
                ),
            ]);
            let request = || Request {
                root: fixture.root.clone(),
                state_domain: Some(fixture.root_id.clone()),
                deployment,
                endpoints: endpoints.clone(),
                native: vec![],
            };
            let executable = Path::new(env!("CARGO_BIN_EXE_maka"));
            // No candidate is launched by the fixture. Both public entry calls must
            // reach the actual CLI ensure/launch serialization and converge.
            let (first, second) = tokio::join!(
                startup::connect(executable, request()),
                startup::connect(executable, request()),
            );
            let mut first = first.unwrap();
            let mut second = second.unwrap();
            assert_eq!(first.epoch(), second.epoch());
            assert!(!first.epoch().is_nil());
            assert_eq!(first.source(), &source);
            assert_eq!(second.source(), &source);
            let found = discovery::read(&fixture.root).unwrap();
            assert_eq!(found.host_epoch, first.epoch());
            let status = Client::status(&found.endpoint, Some(first.epoch()))
                .await
                .unwrap();
            found.verify(&status).unwrap();
            assert_eq!(
                query(&first, "business", "read", Value::Null).await,
                json!({"effects":0})
            );

            let mut write = first
                .call("business", "write".into(), Value::Null, Default::default())
                .await
                .unwrap();
            write.start().await.unwrap();
            assert!(matches!(
                write.receive().await.unwrap(),
                Reply::Prepared { .. }
            ));
            let reference = write.reference().unwrap().clone();
            assert_eq!(reference.source, source);
            // Preparation owns no dispatched effect. The real Host journal, not a
            // fabricated caller attestation, admits this mutation on confirmation.
            assert_eq!(
                query(&second, "business", "read", Value::Null).await,
                json!({"effects":0})
            );
            let reply = match write.confirm().await.unwrap() {
                Reply::Mutation {
                    reply,
                    cleanup: Ok(()),
                } => *reply,
                other => panic!("owned confirmation must settle its original mutation: {other:?}"),
            };
            assert!(write.cleanup_confirmed());
            assert_eq!(reply.reference, reference);
            assert_eq!(
                reply.receipt,
                Receipt::Recorded {
                    outcome: OperationOutcome::Returned {
                        value: json!({"effects":1})
                    },
                    cleanup: OperationCleanup::Confirmed,
                }
            );
            first.close().await.unwrap();
            assert!(
                first
                    .call("business", "read".into(), Value::Null, Default::default())
                    .await
                    .is_err()
            );
            let recovered: OperationReply = serde_json::from_value(
                query(
                    &second,
                    "receipts",
                    "read",
                    serde_json::to_value(&reference).unwrap(),
                )
                .await,
            )
            .unwrap();
            assert_eq!(recovered, reply);
            assert_eq!(
                query(&second, "business", "read", Value::Null).await,
                json!({"effects":1})
            );

            let impossible_helper = directory.path().join("never-created-startup-helper");
            assert_eq!(
                startup::connect(Path::new("maka"), request())
                    .await
                    .err()
                    .unwrap(),
                "local Host startup executable must be absolute"
            );
            let mut reused = startup::connect(executable, request()).await.unwrap();
            assert_eq!(
                reused.epoch(),
                second.epoch(),
                "startup policy must reuse the current Host"
            );
            assert_eq!(reused.source(), &source);
            let mut wrong_domain = request();
            wrong_domain.state_domain.as_mut().unwrap().replace_range(
                0..1,
                if fixture.root_id.starts_with('0') {
                    "1"
                } else {
                    "0"
                },
            );
            assert!(startup::connect(executable, wrong_domain).await.is_err());
            let mut wrong_deployment = request();
            wrong_deployment.deployment = Uuid::new_v4();
            assert!(
                startup::connect(executable, wrong_deployment)
                    .await
                    .is_err()
            );
            let mut invalid = request();
            invalid.root = PathBuf::from("relative-root");
            assert_eq!(
                startup::connect(&impossible_helper, invalid)
                    .await
                    .err()
                    .unwrap(),
                "invalid local Host startup selection"
            );

            let original = fs::read(&fixture.registration).unwrap();
            let mut stale: Value = serde_json::from_slice(&original).unwrap();
            stale["pid"] = json!(status.pid.get() + 1);
            fs::write(&fixture.registration, serde_json::to_vec(&stale).unwrap()).unwrap();
            let rejected = startup::connect(executable, request()).await;
            fs::write(&fixture.registration, original).unwrap();
            assert!(rejected.is_err(), "stale Host discovery must be rejected");

            // A complete valid startup request may exceed the old512KiB
            // policy. Live reuse validates its original Root/deployment and
            // retains the running Host's captured catalogue after the launcher
            // checks policy, without installing newly proposed aliases.
            let mut complete = request();
            complete.endpoints = (0..64)
                .map(|index| {
                    (
                        format!("business-{index:03}-{}", "x".repeat(8192)),
                        endpoints["business"].clone(),
                    )
                })
                .collect();
            complete.validate().unwrap();
            assert!(serde_json::to_vec(&complete).unwrap().len() > 512 * 1024);
            let mut complete_client = startup::connect(executable, complete).await.unwrap();
            assert_eq!(
                complete_client.epoch(),
                second.epoch(),
                "startup policy must reuse the current Host"
            );
            assert_eq!(complete_client.source(), &source);
            assert_eq!(
                serde_json::to_value(complete_client.catalogue()).unwrap(),
                serde_json::to_value(second.catalogue()).unwrap(),
                "reuse must retain the original captured endpoint authority"
            );
            assert_eq!(
                query(&complete_client, "business", "read", Value::Null).await,
                json!({"effects":1})
            );
            complete_client.close().await.unwrap();
            assert_eq!(
                query(&second, "business", "read", Value::Null).await,
                json!({"effects":1})
            );
            reused.close().await.unwrap();

            // Startup Anchor EOF is asynchronous. Observe the real session count,
            // rather than mistaking helper drop for last-client ownership.
            tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    let status = Client::status(&found.endpoint, Some(second.epoch()))
                        .await
                        .unwrap();
                    found.verify(&status).unwrap();
                    if status.sessions == 1 {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("startup helper residency must leave only the accepted last Client");
            second.quit().await.unwrap();
            tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    match RootOwner::open(&fixture.root, &namespaces) {
                        Ok(owner) => {
                            assert_eq!(owner.root_id(), fixture.root_id);
                            drop(owner);
                            break;
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            tokio::task::yield_now().await
                        }
                        Err(error) => {
                            panic!("reopen original Root after last-client quit: {error}")
                        }
                    }
                }
            })
            .await
            .expect("last-client quit must release the original Root");
            assert!(!fixture.registration.exists());
            #[cfg(unix)]
            assert!(!found.endpoint.exists());
        })
        .await
        .unwrap();
    });
}

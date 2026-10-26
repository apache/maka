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
use maka_host_runtime::application::{Binding, Client, operations::RECEIPT_READER};
use maka_plugin_core::operation::{RecoveryRef, receipt_reader_contract};

fn reader_source(configuration: Value) -> (Input, Vec<Package>) {
    let contract = receipt_reader_contract();
    let mut reader = entry(
        true,
        Implementation::Native {
            implementation: RECEIPT_READER.into(),
        },
        MethodMode::Query,
    );
    reader.exports = BTreeMap::from([(
        "Receipts".into(),
        Export {
            contract: contract.clone(),
            availability: Availability::Required,
        },
    )]);
    let reader = package("receipts", reader, None);
    let mut forwarding = entry(
        true,
        Implementation::JavaScript {
            module: "host.mjs".into(),
            realm: Realm::Shared,
        },
        MethodMode::Query,
    );
    forwarding.imports = BTreeMap::from([(
        "receipts".into(),
        Import {
            contract,
            cardinality: Cardinality::One,
        },
    )]);
    let source = format!(
        r#"
        export const service = {{ async echo(input, _observation, context) {{
            return JSON.stringify(await context.invoke({{
                operation:'call', import:'receipts', provider:0, method:'read',
                input:JSON.parse(input), attachments:{{}}
            }}));
        }} }};
        export function activate() {{ return {{ echo: {{ contract:{}, service:['service'] }} }}; }}
    "#,
        serde_json::to_string(&self::contract(MethodMode::Query)).unwrap()
    );
    let forwarding = package("receipt-forwarder", forwarding, Some(source));
    let observer = consumer();
    let mut provider = node(&reader, 7, true);
    provider.configuration.values = serde_json::from_value(configuration).unwrap();
    let mut forwarder = node(&forwarding, 2, true);
    forwarder.bindings = BTreeMap::from([(
        "receipts".into(),
        vec![Target::Instance {
            path: vec!["receipts".into()],
            export: "Receipts".into(),
        }],
    )]);
    let mut observer_node = node(&observer, 3, false);
    observer_node.bindings.get_mut("echo").unwrap()[0] = Target::Instance {
        path: vec!["forwarder".into()],
        export: "echo".into(),
    };
    (
        Input {
            environment: Environment {
                location: ExecutionLocation::Host,
                presentation: None,
            },
            instances: BTreeMap::from([
                ("receipts".into(), provider),
                ("forwarder".into(), forwarder),
                ("observer".into(), observer_node),
            ]),
            recovery: None,
            launch: None,
        },
        vec![reader, forwarding, observer],
    )
}
async fn reader_application(
    store: Arc<RootStore>,
    deployment: Uuid,
    issuer: &Issuer,
    recovery: Arc<AtomicBool>,
) -> Application {
    let app = Application::start_from_store(
        store,
        deployment,
        NativeRegistry::default(),
        issuer.clone(),
        Arc::new(RecoveryGrant {
            issuer: issuer.clone(),
            recovery,
        }),
        Some(maka_host_js::factory(Limits::default())),
    )
    .await
    .unwrap();
    app.ready().await.unwrap();
    app
}
async fn reader_binding(client: &Client) -> Binding {
    client
        .bind(client.activation(&id(2)).unwrap(), "receipts".into())
        .await
        .unwrap()
        .remove(0)
}
async fn read(
    client: &Client,
    binding: Binding,
    reference: &RecoveryRef,
    issuer: &Issuer,
) -> OperationReply {
    let completion = client
        .start(
            binding,
            "read".into(),
            serde_json::to_value(reference).unwrap(),
            scope(issuer, true),
            Attachments::new().into(),
        )
        .await
        .unwrap()
        .completion()
        .await;
    completion.cleanup.unwrap();
    let reply: OperationReply = serde_json::from_value(completion.result.unwrap()).unwrap();
    assert_eq!(reply.reference, *reference);
    reply
}
async fn script_read(client: &Client, reference: &RecoveryRef, issuer: &Issuer) -> OperationReply {
    let binding = client
        .bind(client.activation(&id(3)).unwrap(), "echo".into())
        .await
        .unwrap()
        .remove(0);
    let completion = client
        .start(
            binding,
            "echo".into(),
            json!(serde_json::to_string(reference).unwrap()),
            scope(issuer, true),
            Attachments::new().into(),
        )
        .await
        .unwrap()
        .completion()
        .await;
    completion.cleanup.unwrap();
    let value = completion.result.unwrap();
    let reply: OperationReply = serde_json::from_str(value.as_str().unwrap()).unwrap();
    assert_eq!(reply.reference, *reference);
    reply
}

#[tokio::test]
async fn composed_receipt_reader_reopens_original_root_without_old_provider_and_never_uses_another_root()
 {
    let (dir, namespaces, store) = store().await;
    let (_other_dir, _other_ns, other) = self::store().await;
    tokio::time::timeout(Duration::from_secs(20), async {
        let issuer = Issuer::default();
        let recovery = Arc::new(AtomicBool::new(false));
        let calls = Arc::new(AtomicUsize::new(0));
        let (app, deployment) = launch(
            store.clone(),
            &issuer,
            recovery.clone(),
            Arc::new(VerifiedEcho {
                caller: id(2),
                store: store.clone(),
                calls: calls.clone(),
            }),
        )
        .await;
        let client = app.client();
        // Providing the implementation did not implicitly activate a reader.
        assert!(client.activation(&id(7)).is_err());
        let binding = client
            .bind(client.activation(&id(2)).unwrap(), "echo".into())
            .await
            .unwrap()
            .remove(0);
        let mutation = mutate(
            &client,
            &store,
            binding,
            "echo".into(),
            json!("original"),
            scope(&issuer, true),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        let reference = mutation.reference.clone();
        let expected = mutation.result().await;
        assert_eq!(returned(expected.clone()), json!("original"));
        let (input, packages) = reader_source(json!({}));
        let replacement = store
            .commit_application(deployment, 1, input.clone(), vec![], packages.clone())
            .await
            .unwrap();
        assert_ne!(replacement, reference.source);
        app.shutdown().await.unwrap();
        drop(app);
        drop(client);
        close(store).await;
        let reopened = Arc::new(
            RootStore::open(Arc::new(
                RootOwner::open(&dir.path().join("root"), &namespaces).unwrap(),
            ))
            .await
            .unwrap(),
        );
        let issuer = Issuer::default();
        let reader =
            reader_application(reopened.clone(), deployment, &issuer, recovery.clone()).await;
        assert_eq!(reader.source(), Some(&replacement));
        let client = reader.client();
        assert!(client.activation(&id(1)).is_err());
        let binding = reader_binding(&client).await;
        let denied = read(&client, binding.clone(), &reference, &issuer).await;
        assert!(unavailable(denied).contains("historical grant denied"));
        recovery.store(true, Ordering::SeqCst);
        assert_eq!(
            read(&client, binding.clone(), &reference, &issuer).await,
            expected
        );
        assert_eq!(script_read(&client, &reference, &issuer).await, expected);
        let mut missing = reference.clone();
        missing.operation = Uuid::new_v4();
        assert!(matches!(
            read(&client, binding.clone(), &missing, &issuer)
                .await
                .receipt,
            Receipt::NotRecorded
        ));
        let mut wrong = reference.clone();
        wrong.fingerprint = format!("sha256-{}", "0".repeat(64));
        assert!(matches!(
            read(&client, binding.clone(), &wrong, &issuer)
                .await
                .receipt,
            Receipt::Unavailable { .. }
        ));
        recovery.store(false, Ordering::SeqCst);
        assert!(matches!(
            read(&client, binding.clone(), &missing, &issuer)
                .await
                .receipt,
            Receipt::Unavailable { .. }
        ));
        assert!(
            client
                .start(
                    binding.clone(),
                    "read".into(),
                    serde_json::to_value(&reference).unwrap(),
                    scope(&issuer, false),
                    Attachments::new().into()
                )
                .await
                .is_err()
        );
        recovery.store(true, Ordering::SeqCst);
        other
            .commit_application(deployment, 0, input, vec![], packages)
            .await
            .unwrap();
        let other_app = reader_application(other.clone(), deployment, &issuer, recovery).await;
        let other_client = other_app.client();
        let other_binding = reader_binding(&other_client).await;
        assert!(
            unavailable(read(&other_client, other_binding, &reference, &issuer).await)
                .contains("foreign operation state domain")
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        other_app.shutdown().await.unwrap();
        drop(other_app);
        drop(other_client);
        close(other).await;
        client
            .retire(client.activation(&id(7)).unwrap())
            .await
            .unwrap();
        assert!(
            client
                .start(
                    binding,
                    "read".into(),
                    serde_json::to_value(&reference).unwrap(),
                    scope(&issuer, true),
                    Attachments::new().into()
                )
                .await
                .is_err()
        );
        reader.shutdown().await.unwrap();
        drop(reader);
        drop(client);
        close(reopened).await;
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn composed_portable_receipts_preserve_exact_journal_values_and_original_reference() {
    let (_dir, _ns, store) = store().await;
    tokio::time::timeout(Duration::from_secs(20), async {
        let issuer = Issuer::default();
        let recovery = Arc::new(AtomicBool::new(true));
        let calls = Arc::new(AtomicUsize::new(0));
        // These output schemas permit actual wide integers and large native values.
        let mut declared = contract(MethodMode::Mutation);
        if let Interface::Service { methods } = &mut declared.interface {
            methods.get_mut("echo").unwrap().output = json!({}).into();
        }
        let mut provider_entry = entry(
            true,
            Implementation::Native {
                implementation: "native.echo".into(),
            },
            MethodMode::Mutation,
        );
        provider_entry.exports.get_mut("echo").unwrap().contract = declared.clone();
        let provider = package("native", provider_entry, None);
        let mut consumer_entry = entry(
            false,
            Implementation::JavaScript {
                module: "host.mjs".into(),
                realm: Realm::Shared,
            },
            MethodMode::Mutation,
        );
        consumer_entry.imports.get_mut("echo").unwrap().contract = declared.clone();
        let consumer = package(
            "consumer",
            consumer_entry,
            Some("export function activate() { return {}; }".into()),
        );
        let deployment = Uuid::new_v4();
        store
            .commit_application(
                deployment,
                0,
                input(&provider, &consumer),
                vec![],
                vec![provider, consumer],
            )
            .await
            .unwrap();
        let app = Application::start_from_store(
            store.clone(),
            deployment,
            registry_contract(Arc::new(ReceiptBoundaryEcho(calls.clone())), declared),
            issuer.clone(),
            Arc::new(RecoveryGrant {
                issuer: issuer.clone(),
                recovery: recovery.clone(),
            }),
            Some(maka_host_js::factory(Limits::default())),
        )
        .await
        .unwrap();
        app.ready().await.unwrap();
        let client = app.client();
        let binding = client
            .bind(client.activation(&id(2)).unwrap(), "echo".into())
            .await
            .unwrap()
            .remove(0);
        let mut originals = Vec::new();
        for input in ["integer", "large"] {
            let mutation = mutate(
                &client,
                &store,
                binding.clone(),
                "echo".into(),
                json!(input),
                scope(&issuer, true),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
            let original = mutation.result().await;
            assert!(matches!(
                original.receipt,
                Receipt::Recorded {
                    outcome: OperationOutcome::Returned { .. },
                    cleanup: OperationCleanup::Confirmed
                }
            ));
            originals.push((input, original));
        }
        let (input, packages) = reader_source(json!({}));
        store
            .commit_application(deployment, 1, input, vec![], packages)
            .await
            .unwrap();
        app.shutdown().await.unwrap();
        drop(app);
        drop(client);
        let reader = reader_application(store.clone(), deployment, &issuer, recovery).await;
        let client = reader.client();
        let binding = reader_binding(&client).await;
        for (input, original) in originals {
            let observed = read(&client, binding.clone(), &original.reference, &issuer).await;
            let scripted = script_read(&client, &original.reference, &issuer).await;
            if input == "integer" {
                assert!(unavailable(observed).contains("cannot be represented"));
                assert!(matches!(scripted.receipt, Receipt::Unavailable { .. }));
            } else {
                assert_eq!(observed, original);
                assert_eq!(scripted, original);
            }
            let raw = client
                .recover(
                    client.activation(&id(2)).unwrap(),
                    original.reference.clone(),
                    scope(&issuer, true),
                )
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                OperationReply {
                    reference: raw.reference,
                    receipt: Receipt::Recorded {
                        outcome: raw.outcome,
                        cleanup: raw.cleanup
                    }
                },
                original
            );
        }
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        reader.shutdown().await.unwrap();
        drop(reader);
        drop(client);
        close(store).await;
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn builtin_receipt_reader_requires_persisted_composition_and_rejects_root_configuration() {
    let (_dir, _ns, store) = store().await;
    tokio::time::timeout(Duration::from_secs(20), async {
        let issuer = Issuer::default();
        let (input, packages) = reader_source(json!({}));
        assert!(
            Application::start(
                input,
                packages,
                NativeRegistry::default(),
                issuer.clone(),
                Arc::new(Grant(issuer.clone())),
                Some(maka_host_js::factory(Limits::default()))
            )
            .err()
            .unwrap()
            .contains("native implementation")
        );
        let (input, packages) = reader_source(json!({"root":"other", "namespace":["forged"]}));
        let deployment = Uuid::new_v4();
        store
            .commit_application(deployment, 0, input, vec![], packages)
            .await
            .unwrap();
        let app = Application::start_from_store(
            store.clone(),
            deployment,
            NativeRegistry::default(),
            issuer.clone(),
            Arc::new(Grant(issuer)),
            Some(maka_host_js::factory(Limits::default())),
        )
        .await
        .unwrap();
        assert!(app.ready().await.unwrap_err().contains("unknown field"));
        app.shutdown().await.unwrap();
        drop(app);
        close(store).await;
    })
    .await
    .unwrap();
}

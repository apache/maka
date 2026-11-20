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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn startup_shared_vm_failure_leaves_independent_domain_and_pending_native_owner_available() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let provider = package(
            "startup.shared",
            entry(
                true,
                Implementation::JavaScript {
                    module: "host.mjs".into(),
                    realm: Realm::Shared,
                },
                MethodMode::Query,
            ),
            Some(format!(
                r#"
                export const service = {{ echo(input) {{ return input; }} }};
                export function activate(config) {{
                    if(config.crash) while(true) {{}}
                    return {{echo:{{contract:{},service:['service']}}}};
                }}
            "#,
                serde_json::to_string(&contract(MethodMode::Query)).unwrap()
            )),
        );
        let consumer = consumer();
        let separate = package(
            "startup.dedicated",
            entry(
                false,
                Implementation::JavaScript {
                    module: "host.mjs".into(),
                    realm: Realm::Dedicated,
                },
                MethodMode::Query,
            ),
            Some("export function activate() { return {}; }".into()),
        );
        let native = native_package();
        let mut desired = input(&provider, &consumer);
        desired
            .instances
            .get_mut("provider")
            .unwrap()
            .configuration
            .values
            .insert("crash".into(), json!(true));
        desired
            .instances
            .insert("other".into(), node(&provider, 4, true));
        desired
            .instances
            .get_mut("b")
            .unwrap()
            .bindings
            .get_mut("echo")
            .unwrap()[0] = Target::Instance {
            path: vec!["other".into()],
            export: "echo".into(),
        };
        desired
            .instances
            .insert("healthy".into(), node(&native, 6, true));
        let mut reader = node(&separate, 7, false);
        reader.bindings.get_mut("echo").unwrap()[0] = Target::Instance {
            path: vec!["healthy".into()],
            export: "echo".into(),
        };
        desired.instances.insert("reader".into(), reader);
        let began = Arc::new(Semaphore::new(0));
        let released = Arc::new(Semaphore::new(0));
        let calls = Arc::new(AtomicUsize::new(0));
        let mut registry = NativeRegistry::default();
        let started = began.clone();
        let release = released.clone();
        let invoked = calls.clone();
        registry
            .insert(
                "native.echo".into(),
                Arc::new(move |_, _| {
                    let started = started.clone();
                    let release = release.clone();
                    let invoked = invoked.clone();
                    Box::pin(async move {
                        started.add_permits(1);
                        permit(&release).await;
                        NativeActivation {
                            exports: Ok(BTreeMap::from([(
                                "echo".into(),
                                Published {
                                    contract: contract(MethodMode::Query),
                                    value: Arc::new(Echo { calls: invoked }) as Arc<dyn Handler>,
                                },
                            )])),
                            owner: native_owner(|| Box::pin(async { Ok(()) })),
                        }
                    })
                }),
            )
            .unwrap();
        let issuer = Issuer::default();
        let app = Application::start(
            desired,
            vec![provider, consumer, separate, native],
            registry,
            issuer.clone(),
            Arc::new(Grant(issuer.clone())),
            Some(maka_host_js::factory(Limits {
                synchronous_slice: Duration::from_millis(200),
                ..Limits::default()
            })),
        )
        .unwrap();
        let client = app.client();
        permit(&began).await;
        assert!(app.ready().await.is_err());
        assert!(!client.snapshot().closing);
        while ![id(1), id(4)]
            .iter()
            .all(|id| client.snapshot().initialization_failures.contains(id))
        {
            tokio::task::yield_now().await;
        }
        for id in [id(1), id(2), id(3), id(4)] {
            assert!(client.ready_instance(&id).await.is_err());
        }
        released.add_permits(1);
        let reader = client.ready_instance(&id(7)).await.unwrap();
        let binding = client.bind(reader, "echo".into()).await.unwrap().remove(0);
        assert_eq!(
            client
                .start(
                    binding,
                    "echo".into(),
                    json!("independent"),
                    scope(&issuer, true),
                    Attachments::new().into()
                )
                .await
                .unwrap()
                .result()
                .await
                .unwrap(),
            json!("independent")
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(app.ready().await.is_err());
        app.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

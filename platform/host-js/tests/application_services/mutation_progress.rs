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
use maka_host_runtime::application::{Binding, Client};
use std::sync::Mutex;

type Callback = dyn Fn(Value, Context) -> BoxFuture<'static, Result<Value>> + Send + Sync;
struct ProgressHandler(Arc<Callback>);
impl Handler for ProgressHandler {
    fn call(&self, _: String, input: Value, context: Context) -> BoxFuture<'static, Result<Value>> {
        (self.0)(input, context)
    }
}
fn progress_contract() -> Contract {
    let mut result = contract(MethodMode::Mutation);
    let Interface::Service { methods } = &mut result.interface else {
        unreachable!()
    };
    methods.get_mut("echo").unwrap().progress = Some(json!({"type":"integer","minimum":0}).into());
    result
}
fn progress_entry(provider: bool, implementation: Implementation) -> EntryDeclaration {
    let mut result = entry(provider, implementation, MethodMode::Mutation);
    if provider {
        result.exports.get_mut("echo").unwrap().contract = progress_contract();
    } else {
        result.imports.get_mut("echo").unwrap().contract = progress_contract();
    }
    result
}
async fn launch_progress(
    store: Arc<RootStore>,
    issuer: &Issuer,
    handler: Option<Arc<dyn Handler>>,
    realm: Realm,
) -> (Application, Client, Binding) {
    let implementation = if handler.is_some() {
        Implementation::Native {
            implementation: "native.echo".into(),
        }
    } else {
        Implementation::JavaScript {
            module: "host.mjs".into(),
            realm,
        }
    };
    let source = handler.is_none().then(|| {
        format!(
            r#"
        let calls=0;
        export const service={{async echo(input, observation, context){{
            if (!observation.operation) throw Error('missing original operation');
            ++calls;
            for(let i=0;i<35;i++) await context.invoke({{operation:'emit',value:i}});
            return input+':'+calls;
        }}}};
        export function activate(){{return {{echo:{{contract:{},service:['service']}}}};}}
    "#,
            serde_json::to_string(&progress_contract()).unwrap()
        )
    });
    let provider = package(
        "progress.provider",
        progress_entry(true, implementation),
        source,
    );
    let consumer = package(
        "progress.consumer",
        progress_entry(
            false,
            Implementation::JavaScript {
                module: "host.mjs".into(),
                realm: Realm::Shared,
            },
        ),
        Some("export function activate(){return {}; }".into()),
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
    let native = handler.map_or_else(NativeRegistry::default, |handler| {
        registry_contract(handler, progress_contract())
    });
    let app = Application::start_from_store(
        store,
        deployment,
        native,
        issuer.clone(),
        Arc::new(RecoveryGrant {
            issuer: issuer.clone(),
            recovery: Arc::new(AtomicBool::new(true)),
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
    (app, client, binding)
}

#[test]
fn progress_is_declared_only_for_mutations_and_changes_contract_identity() {
    let plain = contract(MethodMode::Mutation);
    let progress = progress_contract();
    progress.validate().unwrap();
    assert!(!plain.accepts(&progress));
    assert!(
        serde_json::to_value(&plain).unwrap()["interface"]["methods"]["echo"]
            .get("progress")
            .is_none()
    );
    for mode in [MethodMode::Query, MethodMode::Subscription] {
        let mut invalid = progress.clone();
        let Interface::Service { methods } = &mut invalid.interface else {
            unreachable!()
        };
        methods.get_mut("echo").unwrap().mode = mode;
        assert!(
            invalid
                .validate()
                .unwrap_err()
                .to_string()
                .contains("only mutation")
        );
    }
}

#[tokio::test]
async fn javascript_mutations_stream_before_receipt_and_replay_only_original_outcome() {
    tokio::time::timeout(Duration::from_secs(30), async {
        for realm in [Realm::Shared, Realm::Dedicated] {
            let (_dir, _ns, store) = store().await;
            let issuer = Issuer::default();
            let (app, client, binding) = launch_progress(store.clone(), &issuer, None, realm).await;
            let operation = Uuid::new_v4();
            let mut mutation = mutate(
                &client,
                &store,
                binding.clone(),
                "echo".into(),
                json!("first"),
                scope(&issuer, true),
                operation,
            )
            .await
            .unwrap();
            let reference = mutation.reference.clone();
            assert_eq!(mutation.recv().await, Some(json!(0)));
            let original = store
                .operation(&reference)
                .unwrap()
                .operation_observation()
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                original.outcome,
                OperationOutcome::Unresolved,
                "35 items cannot fit in the original 16-item buffer"
            );
            assert_eq!(original.cleanup, OperationCleanup::Unconfirmed);
            for index in 1..35 {
                assert_eq!(mutation.recv().await, Some(json!(index)));
            }
            assert_eq!(mutation.recv().await, None);
            let completion = mutation.completion().await;
            completion.cleanup.unwrap();
            assert_eq!(returned(completion.reply), json!("first:1"));
            let mut replay = mutate(
                &client,
                &store,
                binding.clone(),
                "echo".into(),
                json!("first"),
                scope(&issuer, true),
                operation,
            )
            .await
            .unwrap();
            assert_eq!(replay.recv().await, None);
            assert_eq!(returned(replay.result().await), json!("first:1"));
            // Existing receipt-only callers drain bounded progress automatically.
            let next = mutate(
                &client,
                &store,
                binding,
                "echo".into(),
                json!("next"),
                scope(&issuer, true),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
            assert_eq!(returned(next.result().await), json!("next:2"));
            app.shutdown().await.unwrap();
            drop(app);
            drop(client);
            close(store).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn mutation_progress_validates_separately_and_retained_emit_cannot_outlive_callback() {
    let (_dir, _ns, store) = store().await;
    tokio::time::timeout(Duration::from_secs(20), async {
        let issuer = Issuer::default();
        let retained = Arc::new(Mutex::new(None));
        let captured = retained.clone();
        let handler = Arc::new(ProgressHandler(Arc::new(move |input, context| {
            let captured = captured.clone();
            Box::pin(async move {
                assert!(
                    context
                        .emit(json!("final output schema is not the progress schema"))
                        .await
                        .is_err()
                );
                assert!(context.emit(json!(-1)).await.is_err());
                context.emit(json!(7)).await?;
                let late = context.emit(json!(8));
                *captured.lock().unwrap() = Some((context, late));
                Ok(input)
            })
        })));
        let (app, client, binding) =
            launch_progress(store.clone(), &issuer, Some(handler), Realm::Shared).await;
        let mut mutation = mutate(
            &client,
            &store,
            binding,
            "echo".into(),
            json!("done"),
            scope(&issuer, true),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        assert_eq!(mutation.recv().await, Some(json!(7)));
        assert_eq!(mutation.recv().await, None);
        let completion = mutation.completion().await;
        completion.cleanup.unwrap();
        assert_eq!(returned(completion.reply), json!("done"));
        let (context, late) = retained.lock().unwrap().take().unwrap();
        assert!(late.await.is_err());
        assert!(context.emit(json!(9)).await.is_err());
        drop(context);
        app.shutdown().await.unwrap();
        drop(app);
        drop(client);
        close(store).await;
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn dropping_mutation_progress_closes_demand_without_cancelling_or_settling_effect() {
    let (_dir, _ns, store) = store().await;
    tokio::time::timeout(Duration::from_secs(20), async {
        let issuer = Issuer::default();
        let release = Arc::new(Semaphore::new(0));
        let finished = Arc::new(Semaphore::new(0));
        let gate = release.clone();
        let done = finished.clone();
        let handler = Arc::new(ProgressHandler(Arc::new(move |input, context| {
            let gate = gate.clone();
            let done = done.clone();
            Box::pin(async move {
                context.emit(json!(1)).await?;
                permit(&gate).await;
                assert!(!context.scope().cancellation.is_cancelled());
                assert!(context.emit(json!(2)).await.is_err());
                assert!(!context.scope().cancellation.is_cancelled());
                done.add_permits(1);
                Ok(input)
            })
        })));
        let (app, client, binding) =
            launch_progress(store.clone(), &issuer, Some(handler), Realm::Shared).await;
        let mut mutation = mutate(
            &client,
            &store,
            binding,
            "echo".into(),
            json!("actual effect"),
            scope(&issuer, true),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        let reference = mutation.reference.clone();
        assert_eq!(mutation.recv().await, Some(json!(1)));
        drop(mutation);
        let pending = store
            .operation(&reference)
            .unwrap()
            .operation_observation()
            .await
            .unwrap()
            .unwrap();
        assert_eq!(pending.outcome, OperationOutcome::Unresolved);
        assert_eq!(pending.cleanup, OperationCleanup::Unconfirmed);
        release.add_permits(1);
        permit(&finished).await;
        app.shutdown().await.unwrap();
        let actual = store
            .operation(&reference)
            .unwrap()
            .operation_observation()
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            actual.outcome,
            OperationOutcome::Returned {
                value: json!("actual effect")
            }
        );
        assert_eq!(actual.cleanup, OperationCleanup::Confirmed);
        drop(app);
        drop(client);
        close(store).await;
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn unread_mutation_progress_does_not_limit_other_effects() {
    let (_dir, _ns, store) = store().await;
    tokio::time::timeout(Duration::from_secs(30), async {
        let issuer = Issuer::default();
        let entered = Arc::new(Semaphore::new(0));
        let counter = Arc::new(AtomicUsize::new(0));
        let signals = entered.clone();
        let calls = counter.clone();
        let handler = Arc::new(ProgressHandler(Arc::new(move |input, context| {
            let signals = signals.clone();
            calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                context.emit(json!(1)).await?;
                signals.add_permits(1);
                Ok(input)
            })
        })));
        let (app, client, binding) =
            launch_progress(store.clone(), &issuer, Some(handler), Realm::Shared).await;
        let mut unread = Vec::new();
        for _ in 0..32 {
            unread.push(
                mutate(
                    &client,
                    &store,
                    binding.clone(),
                    "echo".into(),
                    json!("buffered"),
                    scope(&issuer, true),
                    Uuid::new_v4(),
                )
                .await
                .unwrap(),
            );
            permit(&entered).await;
        }
        let admitted = mutate(
            &client,
            &store,
            binding,
            "echo".into(),
            json!("additional"),
            scope(&issuer, true),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        assert_eq!(returned(admitted.result().await), json!("additional"));
        assert_eq!(counter.load(Ordering::SeqCst), 33);
        for mutation in unread {
            assert_eq!(returned(mutation.result().await), json!("buffered"));
        }
        app.shutdown().await.unwrap();
        drop(app);
        drop(client);
        close(store).await;
    })
    .await
    .unwrap();
}

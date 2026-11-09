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

//! Production Host admission, original receipts and streamed native payloads.
use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use maka_plugin_core::operation::{OperationResult, RecoveryRef};
use sha2::{Digest, Sha256};

fn migration_catalog() -> Vec<maka_event_log::migration::Migration> {
    maka_event_log::ROOT_MIGRATIONS
        .iter()
        .chain(maka_agent_state::MIGRATIONS)
        .cloned()
        .collect()
}
async fn model_scope(f: &Fixture, session: &str) -> Scope {
    let source = f.latest_run(session).await;
    f.issuer
        .issue_with(
            Identity::Agent {
                execution: source.execution(),
                operation_id: None,
            },
            true,
            CancellationToken::new(),
        )
        .unwrap()
}
async fn binding(app: &Application) -> Binding {
    let client = app.client();
    client
        .bind(client.activation(&id(2)).unwrap(), EXPORT.into())
        .await
        .unwrap()
        .remove(0)
}
async fn query(
    app: &Application,
    issuer: &Issuer,
    method: &str,
    input: Value,
) -> Result<Value, String> {
    app.client()
        .start(
            binding(app).await,
            method.into(),
            input,
            scope(issuer, true),
            Attachments::new().into(),
        )
        .await?
        .result()
        .await
}
async fn input(f: &Fixture, session: &str, expected: Value) -> Value {
    let preview = f
        .query("previewHistoryCheckpoint", json!({"sessionId":session}))
        .await
        .unwrap();
    assert_eq!(preview["rootSessionId"], session);
    json!({"sessionId":session,"expectedRevision":expected,"confirmedSubtreeDigest":preview["subtreeDigest"],"workspaceConsistency":null})
}
async fn publish(f: &Fixture, input: Value, operation: Uuid) -> (RecoveryRef, Receipt) {
    let client = f.app.client();
    let prepared = client
        .prepare_mutation(
            f.binding(2).await,
            "publishCheckpoint".into(),
            input.clone(),
            scope(&f.issuer, true),
            operation,
            Attachments::new().into(),
        )
        .await
        .unwrap();
    let reference = prepared.reference().clone();
    let reply = client
        .mutate_owned(prepared, input)
        .await
        .unwrap()
        .result()
        .await;
    (reference, reply.receipt)
}
fn published(receipt: Receipt) -> Value {
    let Receipt::Recorded {
        outcome:
            OperationOutcome::Returned {
                result: OperationResult::Success { value },
            },
        ..
    } = receipt
    else {
        panic!("{receipt:?}")
    };
    assert_eq!(value["state"]["kind"], "published");
    value
}
async fn read(
    app: &Application,
    store: &RootStore,
    state: &maka_agent_state::Store,
    issuer: &Issuer,
    session: &str,
    revision: Value,
) -> Result<(Value, Vec<u8>), String> {
    let observed = scope(issuer, true);
    let mut stream = app
        .client()
        .subscribe(
            binding(app).await,
            "readHistoryCheckpoint".into(),
            json!({"sessionId":session,"revision":revision}),
            observed.clone(),
            Attachments::new().into(),
        )
        .await?;
    let mut begin = Value::Null;
    let mut bytes = Vec::new();
    let mut ended = false;
    while let Some(frame) = stream.recv().await {
        match frame["kind"].as_str().unwrap() {
            "checkpoint" => {
                assert!(begin.is_null());
                begin = frame;
            }
            "chunk" => {
                assert!(!begin.is_null() && !ended);
                assert_eq!(frame["offset"], bytes.len() as u64);
                let chunk = STANDARD.decode(frame["data"].as_str().unwrap()).unwrap();
                assert!(!chunk.is_empty() && chunk.len() <= 32 * 1024);
                bytes.extend(chunk);
            }
            "end" => {
                assert!(!ended);
                ended = true;
                assert_eq!(frame["bytes"], bytes.len() as u64);
                assert_eq!(frame["digest"], hex::encode(Sha256::digest(&bytes)));
                assert_eq!(frame["digest"], begin["history"]["object"]["digest"]);
            }
            _ => panic!("{frame}"),
        }
    }
    let completion = stream.completion().await;
    observed.resources.finish().await.unwrap();
    completion.cleanup?;
    assert_eq!(completion.result?, Value::Null);
    assert!(ended);
    let expected: maka_event_log::checkpoints::HistorySnapshot =
        serde_json::from_value(begin["history"].clone()).unwrap();
    let origin: maka_agent_facts::history_snapshot::Origin =
        serde_json::from_slice(&expected.cut).unwrap();
    let maka_agent_facts::history_snapshot::Origin::Canonical { cut } = origin else {
        panic!("native checkpoint must retain its canonical Session origin")
    };
    assert_eq!(cut.session, session);
    let copied = bytes.clone();
    let file = store
        .session(session)
        .await
        .unwrap()
        .with_resource_io(move || {
            use std::io::{Seek, Write};
            let mut file = maka_event_log::root_store::create_request_file()?;
            file.write_all(&copied)?;
            file.rewind()?;
            Ok(file)
        })
        .await
        .unwrap();
    let verification = scope(issuer, true);
    let source = state
        .session_history(cut.owner.clone(), session.into())
        .import_snapshot(
            Uuid::new_v4(),
            expected,
            file,
            verification.cancellation.child_token(),
        )
        .await
        .unwrap();
    assert_eq!(
        source.manifest().await.unwrap().origin,
        maka_agent_facts::history_snapshot::Origin::Canonical { cut }
    );
    verification.resources.finish().await.unwrap();
    Ok((begin, bytes))
}
async fn turn(f: &Fixture, listener: &TcpListener, session: &str, text: &str) {
    f.send(session).await.unwrap();
    let (mut socket, _) = listener.accept().await.unwrap();
    request(&mut socket).await;
    response_with_text(&mut socket, text).await;
    f.drained().await;
}
#[path = "checkpoints/benchmark.rs"]
mod benchmark;
#[path = "checkpoints/load.rs"]
mod load;
#[path = "checkpoints/workspace.rs"]
mod workspace;

async fn close(f: &Fixture) {
    f.app.shutdown().await.unwrap();
    f.config.shutdown().await.unwrap();
}

#[tokio::test]
async fn host_publication_preserves_original_bytes_after_live_history_and_head_move() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Fixture::new(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
        )
        .await;
        let session = f.create("History checkpoint").await;
        let artifact = vec![b'x'; 128 * 1024 + 7];
        assert_eq!(
            attachments::upload(&f, &session, "checkpoint.txt", &artifact, Uuid::new_v4())
                .await
                .unwrap()["kind"],
            "uploaded"
        );
        turn(&f, &listener, &session, "before checkpoint").await;
        let original = input(&f, &session, Value::Null).await;
        let operation = Uuid::new_v4();
        let (reference, receipt) = publish(&f, original.clone(), operation).await;
        let result = published(receipt);
        let head = result["state"]["head"].clone();
        assert_eq!(
            f.query("historyCheckpointHead", json!({"sessionId":session}))
                .await
                .unwrap(),
            head
        );
        let (begin, bytes) = read(
            &f.app,
            &f.store,
            &f.owner.durable,
            &f.issuer,
            &session,
            head["revision"].clone(),
        )
        .await
        .unwrap();
        assert!(bytes.windows(artifact.len()).any(|part| part == artifact));
        turn(&f, &listener, &session, "after checkpoint").await;
        let observation = f
            .query(
                "checkpointReceipt",
                json!({"reference":reference,"input":original}),
            )
            .await
            .unwrap();
        assert_eq!(observation["publication"], result);
        assert_eq!(observation["operation"]["outcome"]["kind"], "returned");
        assert_eq!(
            published(publish(&f, original.clone(), operation).await.1),
            result
        );
        let (again, again_bytes) = read(
            &f.app,
            &f.store,
            &f.owner.durable,
            &f.issuer,
            &session,
            head["revision"].clone(),
        )
        .await
        .unwrap();
        assert_eq!(again, begin);
        assert_eq!(again_bytes, bytes);
        let (_, conflict) = publish(&f, original.clone(), Uuid::new_v4()).await;
        let Receipt::Recorded {
            outcome:
                OperationOutcome::Returned {
                    result: OperationResult::Success { value },
                },
            ..
        } = conflict
        else {
            panic!("{conflict:?}")
        };
        assert_eq!(
            value["state"],
            json!({"kind":"conflict","actual":head["revision"]})
        );
        let next = input(&f, &session, head["revision"].clone()).await;
        let next = published(publish(&f, next, Uuid::new_v4()).await.1);
        assert_ne!(next["state"]["head"]["revision"], head["revision"]);
        assert!(
            read(
                &f.app,
                &f.store,
                &f.owner.durable,
                &f.issuer,
                &session,
                head["revision"].clone()
            )
            .await
            .is_err()
        );
        let receipt = f
            .query(
                "checkpointReceipt",
                json!({"reference":reference,"input":original}),
            )
            .await
            .unwrap();
        assert_eq!(receipt["publication"], result);
        close(&f).await;
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn busy_source_is_not_queued_or_republished_by_receipt_lookup() {
    tokio::time::timeout(Duration::from_secs(60),async {
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f=Fixture::new(&format!("http://{}/v1",listener.local_addr().unwrap()),None).await;
        let session=f.create("Busy checkpoint source").await;
        let original=input(&f,&session,Value::Null).await;
        f.send(&session).await.unwrap();
        let (mut socket,_)=listener.accept().await.unwrap(); request(&mut socket).await;
        let operation=Uuid::new_v4();
        let (reference,receipt)=publish(&f,original.clone(),operation).await;
        assert!(matches!(receipt,Receipt::Recorded {outcome:OperationOutcome::Returned { result:OperationResult::Failure {ref diagnostic} },..} if diagnostic=="agent_checkpoint_busy" || diagnostic=="agent_history_checkpoint_busy"));
        response(&mut socket).await; f.drained().await;
        let receipt=f.query("checkpointReceipt",json!({"reference":reference,"input":original})).await.unwrap();
        assert!(receipt["publication"].is_null(),"busy preflight must not create a Root publication: {receipt}");
        assert_eq!(receipt["operation"]["outcome"]["result"]["kind"],"failure");
        let (_,again)=publish(&f,original.clone(),operation).await;
        assert!(matches!(again,Receipt::Recorded { outcome:OperationOutcome::Returned { result:OperationResult::Failure {..} },.. }));
        assert!(f.query("historyCheckpointHead",json!({"sessionId":session})).await.unwrap().is_null());
        let current=input(&f,&session,Value::Null).await;
        published(publish(&f,current,Uuid::new_v4()).await.1);
        close(&f).await;
    }).await.unwrap();
}

#[tokio::test]
async fn host_policy_identity_original_fingerprint_and_close_are_enforced() {
    let f = Fixture::new("http://127.0.0.1:1/v1", None).await;
    let session = f.create("Checkpoint authorization").await;
    let original = input(&f, &session, Value::Null).await;
    let denied = f
        .app
        .client()
        .prepare_mutation(
            f.binding(2).await,
            "publishCheckpoint".into(),
            original.clone(),
            scope(&f.issuer, false),
            Uuid::new_v4(),
            Attachments::new().into(),
        )
        .await;
    assert!(denied.is_err());
    assert!(
        f.query("previewHistoryCheckpoint", json!({"sessionId":"foreign"}))
            .await
            .is_err()
    );
    assert!(
        f.query("historyCheckpointHead", json!({"sessionId":"foreign"}))
            .await
            .is_err()
    );
    let operation = Uuid::new_v4();
    let (reference, receipt) = publish(&f, original.clone(), operation).await;
    published(receipt);
    let mut changed = original.clone();
    changed["expectedRevision"] = json!(Uuid::new_v4());
    assert!(
        f.query(
            "checkpointReceipt",
            json!({"reference":reference,"input":changed})
        )
        .await
        .is_err()
    );
    assert!(
        f.mutation(2, "publishCheckpoint", changed, operation)
            .await
            .is_err()
    );
    let mut foreign = reference.clone();
    foreign.namespace = id(99);
    assert!(
        f.query(
            "checkpointReceipt",
            json!({"reference":foreign,"input":original})
        )
        .await
        .is_err()
    );
    let mut absent = reference.clone();
    absent.operation = Uuid::new_v4();
    let result = f
        .query(
            "checkpointReceipt",
            json!({"reference":absent,"input":original}),
        )
        .await
        .unwrap();
    assert_eq!(result, json!({"operation":null,"publication":null}));
    let old_binding = f.binding(2).await;
    close(&f).await;
    assert!(
        f.app
            .client()
            .start(
                old_binding,
                "historyCheckpointHead".into(),
                json!({"sessionId":session}),
                scope(&f.issuer, true),
                Attachments::new().into()
            )
            .await
            .is_err()
    );
}

#[tokio::test]
async fn root_reopen_disambiguates_domain_success_without_fabricating_host_cleanup() {
    tokio::time::timeout(Duration::from_secs(90),async {
        let f=Fixture::new("http://127.0.0.1:1/v1",None).await;
        let session=f.create("Lost Host settlement").await;
        let original=input(&f,&session,Value::Null).await;
        // A real SQL failure after the separate checkpoint transaction commits.
        // Install in every possible Host operation partition, not the Session partition.
        for path in f.runtime_databases() {
            rusqlite::Connection::open(path).unwrap().execute_batch("CREATE TRIGGER checkpoint_host_failure BEFORE UPDATE ON application_operations WHEN json_extract(OLD.request_json,'$.method')='publishCheckpoint' BEGIN SELECT RAISE(ABORT,'fixture lost Host settlement'); END;").unwrap();
        }
        let (reference,receipt)=publish(&f,original.clone(),Uuid::new_v4()).await;
        assert!(matches!(receipt,Receipt::Unavailable {..}),"{receipt:?}");
        let head=f.query("historyCheckpointHead",json!({"sessionId":session})).await.unwrap();
        assert!(!head.is_null());
        let (_,before)=read(&f.app,&f.store, &f.owner.durable,&f.issuer,&session,head["revision"].clone()).await.unwrap();
        assert_eq!(attachments::upload(&f,&session,"after-checkpoint.txt",b"new live state after uncertain publication",Uuid::new_v4()).await.unwrap()["kind"],"uploaded");
        for path in f.runtime_databases() {rusqlite::Connection::open(path).unwrap().execute_batch("DROP TRIGGER checkpoint_host_failure").unwrap();}
        let deployment=f.app.source().unwrap().deployment;
        close(&f).await;
        let Fixture{_dir,namespaces,root,store,config,app,issuer,owner,services,..}=f;
        drop(app); drop(owner); drop(services); drop(config);
        Arc::try_unwrap(store).ok().expect("all Host owners released Root").close().await.unwrap();
        let store=Arc::new(RootStore::open(Arc::new(RootOwner::open_existing(&root,&namespaces).unwrap()),&migration_catalog()).await.unwrap());
        let data=store.data_writer().unwrap();
        let state=maka_agent_state::Store::new(data.clone(),maka_agent_state::DriverDomain::new(data).unwrap()).unwrap();
        let mut registry=NativeRegistry::default();
        maka_settings_native::provide(&mut registry,bundled_catalog()).unwrap();
        provide_all(&mut registry,state.clone()).unwrap();
        let app=Application::start_from_store(store.clone(),deployment,registry,issuer.clone(),Arc::new(Grant(issuer.clone(),None)),Some(maka_host_js::factory(Default::default()))).await.unwrap();
        app.ready().await.unwrap();
        let receipt=query(&app,&issuer,"checkpointReceipt",json!({"reference":reference,"input":original})).await.unwrap();
        assert_eq!(receipt["publication"]["state"],json!({"kind":"published","head":head}));
        assert_eq!(receipt["operation"]["outcome"]["kind"],"unresolved");
        assert_eq!(receipt["operation"]["cleanup"]["kind"],"unconfirmed");
        let (_,after)=read(&app,&store,&state,&issuer,&session,head["revision"].clone()).await.unwrap();
        assert_eq!(before,after);
        app.shutdown().await.unwrap(); drop(app);
        drop(state);store.shutdown().await.unwrap(); drop(store); drop(_dir);
    }).await.unwrap();
}

#[tokio::test]
async fn cancellation_drains_bounded_reader_and_corruption_never_emits_success() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let f = Fixture::new("http://127.0.0.1:1/v1", None).await;
        let session = f.create("Bounded checkpoint read").await;
        assert_eq!(
            attachments::upload(
                &f,
                &session,
                "large.bin",
                &vec![17; 2 * 1024 * 1024],
                Uuid::new_v4()
            )
            .await
            .unwrap()["kind"],
            "uploaded"
        );
        let published = published(
            publish(&f, input(&f, &session, Value::Null).await, Uuid::new_v4())
                .await
                .1,
        );
        let head = &published["state"]["head"];
        let observed = scope(&f.issuer, true);
        let mut stream = f
            .app
            .client()
            .subscribe(
                f.binding(2).await,
                "readHistoryCheckpoint".into(),
                json!({"sessionId":session,"revision":head["revision"]}),
                observed.clone(),
                Attachments::new().into(),
            )
            .await
            .unwrap();
        let first = stream.recv().await.unwrap();
        assert_eq!(first["kind"], "checkpoint");
        stream.cancel();
        let completion = stream.completion().await;
        assert!(completion.result.is_err());
        completion.cleanup.unwrap();
        observed.resources.finish().await.unwrap();
        assert!(observed.resources.is_idle());
        let path = f
            .root
            .join("history-checkpoints/objects")
            .join(head["manifest"]["digest"].as_str().unwrap());
        std::fs::write(path, b"damaged").unwrap();
        assert!(
            read(
                &f.app,
                &f.store,
                &f.owner.durable,
                &f.issuer,
                &session,
                head["revision"].clone()
            )
            .await
            .is_err()
        );
        assert_eq!(
            f.query("historyCheckpointHead", json!({"sessionId":session}))
                .await
                .unwrap(),
            *head
        );
        close(&f).await;
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn model_scope_and_missing_recovery_grant_cannot_read_checkpoint_receipts() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(
        &format!("http://{}/v1", listener.local_addr().unwrap()),
        None,
    )
    .await;
    let session = f.create("Explicit management only").await;
    let original = input(&f, &session, Value::Null).await;
    turn(&f, &listener, &session, "real checkpoint management caller").await;
    let model = model_scope(&f, &session).await;
    let attempt = f
        .app
        .client()
        .start(
            f.binding(2).await,
            "previewHistoryCheckpoint".into(),
            json!({"sessionId":session}),
            model,
            Attachments::new().into(),
        )
        .await
        .unwrap()
        .result()
        .await;
    assert_eq!(
        attempt.unwrap_err(),
        "agent_history_checkpoint_user_action_required"
    );
    let (reference, receipt) = publish(&f, original.clone(), Uuid::new_v4()).await;
    published(receipt);
    struct NoRecovery(Grant);
    impl Policy for NoRecovery {
        fn admit(&self, invocation: HostInvocation<'_>) -> Result<(), String> {
            self.0.admit(invocation)
        }
        fn recover(
            &self,
            _: maka_host_runtime::application::RecoveryInvocation<'_>,
        ) -> Result<(), String> {
            Err("recovery explicitly denied".into())
        }
    }
    let roots = f.owner.settings.workspace_roots.clone();
    let policy = Arc::new(NoRecovery(Grant(f.issuer.clone(), None)));
    workspaces::publish_with_policy(&mut f, roots, policy).await;
    assert_eq!(
        f.query(
            "checkpointReceipt",
            json!({"reference":reference,"input":original})
        )
        .await
        .unwrap_err(),
        "recovery explicitly denied"
    );
    close(&f).await;
}

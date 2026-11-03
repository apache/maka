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
use maka_event_log::bundle::StagedBundle;
use maka_plugin_core::operation::RecoveryRef;
use sha2::{Digest, Sha256};

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
    json!({"sessionId":session,"expectedRevision":expected,"confirmedSubtreeDigest":preview["subtreeDigest"]})
}
async fn publish(f: &Fixture, input: Value, operation: Uuid) -> (RecoveryRef, Receipt) {
    let client = f.app.client();
    let prepared = client
        .prepare_mutation(
            f.binding(2).await,
            "publishHistoryCheckpoint".into(),
            input,
            scope(&f.issuer, true),
            operation,
            Attachments::new().into(),
        )
        .await
        .unwrap();
    let reference = prepared.reference().clone();
    let reply = client.mutate_owned(prepared).await.unwrap().result().await;
    (reference, reply.receipt)
}
fn published(receipt: Receipt) -> Value {
    let Receipt::Recorded {
        outcome: OperationOutcome::Returned { value },
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
            "native_history_v1" => {
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
                assert_eq!(frame["digest"], begin["bundle"]["digest"]);
            }
            _ => panic!("{frame}"),
        }
    }
    let completion = stream.completion().await;
    observed.resources.finish().await.unwrap();
    completion.cleanup?;
    assert_eq!(completion.result?, Value::Null);
    assert!(ended);
    let mut stage = StagedBundle::read(bytes.as_slice()).await.unwrap();
    stage.validate_history().await.unwrap();
    assert_eq!(stage.summary().inventory.root_session_id, session);
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
        let (begin, bytes) = read(&f.app, &f.issuer, &session, head["revision"].clone())
            .await
            .unwrap();
        assert!(bytes.windows(artifact.len()).any(|part| part == artifact));
        turn(&f, &listener, &session, "after checkpoint").await;
        let observation = f
            .query(
                "historyCheckpointReceipt",
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
        let (again, again_bytes) = read(&f.app, &f.issuer, &session, head["revision"].clone())
            .await
            .unwrap();
        assert_eq!(again, begin);
        assert_eq!(again_bytes, bytes);
        let (_, conflict) = publish(&f, original.clone(), Uuid::new_v4()).await;
        let Receipt::Recorded {
            outcome: OperationOutcome::Returned { value },
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
            read(&f.app, &f.issuer, &session, head["revision"].clone())
                .await
                .is_err()
        );
        let receipt = f
            .query(
                "historyCheckpointReceipt",
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
        assert!(matches!(receipt,Receipt::Recorded {outcome:OperationOutcome::Unknown {ref diagnostic},..} if diagnostic=="agent_history_checkpoint_busy"));
        response(&mut socket).await; f.drained().await;
        let receipt=f.query("historyCheckpointReceipt",json!({"reference":reference,"input":original})).await.unwrap();
        assert_eq!(receipt["publication"]["state"]["kind"],"interrupted");
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
            "publishHistoryCheckpoint".into(),
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
            "historyCheckpointReceipt",
            json!({"reference":reference,"input":changed})
        )
        .await
        .is_err()
    );
    assert!(
        f.mutation(2, "publishHistoryCheckpoint", changed, operation)
            .await
            .is_err()
    );
    let mut foreign = reference.clone();
    foreign.namespace = id(99);
    assert!(
        f.query(
            "historyCheckpointReceipt",
            json!({"reference":foreign,"input":original})
        )
        .await
        .is_err()
    );
    let mut absent = reference.clone();
    absent.operation = Uuid::new_v4();
    let result = f
        .query(
            "historyCheckpointReceipt",
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
            rusqlite::Connection::open(path).unwrap().execute_batch("CREATE TRIGGER checkpoint_host_failure BEFORE UPDATE ON application_operations WHEN json_extract(OLD.request_json,'$.method')='publishHistoryCheckpoint' BEGIN SELECT RAISE(ABORT,'fixture lost Host settlement'); END;").unwrap();
        }
        let (reference,receipt)=publish(&f,original.clone(),Uuid::new_v4()).await;
        assert!(matches!(receipt,Receipt::Unavailable {..}),"{receipt:?}");
        let head=f.query("historyCheckpointHead",json!({"sessionId":session})).await.unwrap();
        assert!(!head.is_null());
        let (_,before)=read(&f.app,&f.issuer,&session,head["revision"].clone()).await.unwrap();
        assert_eq!(attachments::upload(&f,&session,"after-checkpoint.txt",b"new live state after uncertain publication",Uuid::new_v4()).await.unwrap()["kind"],"uploaded");
        for path in f.runtime_databases() {rusqlite::Connection::open(path).unwrap().execute_batch("DROP TRIGGER checkpoint_host_failure").unwrap();}
        let deployment=f.app.source().unwrap().deployment;
        close(&f).await;
        let Fixture{_dir,namespaces,root,store,config,app,issuer,owner,services,..}=f;
        drop(app); drop(owner); drop(services); drop(config);
        Arc::try_unwrap(store).ok().expect("all Host owners released Root").close().await.unwrap();
        let store=Arc::new(RootStore::open(Arc::new(RootOwner::open_existing(&root,&namespaces).unwrap())).await.unwrap());
        let mut registry=NativeRegistry::default();
        maka_settings_native::provide(&mut registry,bundled_catalog()).unwrap();
        provide_all(&mut registry).unwrap();
        let app=Application::start_from_store(store.clone(),deployment,registry,issuer.clone(),Arc::new(Grant(issuer.clone(),None)),Some(maka_host_js::factory(Default::default()))).await.unwrap();
        app.ready().await.unwrap();
        let receipt=query(&app,&issuer,"historyCheckpointReceipt",json!({"reference":reference,"input":original})).await.unwrap();
        assert_eq!(receipt["publication"]["state"],json!({"kind":"published","head":head}));
        assert_eq!(receipt["operation"]["outcome"]["kind"],"unresolved");
        assert_eq!(receipt["operation"]["cleanup"]["kind"],"unconfirmed");
        let (_,after)=read(&app,&issuer,&session,head["revision"].clone()).await.unwrap();
        assert_eq!(before,after);
        app.shutdown().await.unwrap(); drop(app);
        store.shutdown().await.unwrap(); drop(store); drop(_dir);
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
        assert_eq!(first["kind"], "native_history_v1");
        stream.cancel();
        let completion = stream.completion().await;
        assert!(completion.result.is_err());
        completion.cleanup.unwrap();
        observed.resources.finish().await.unwrap();
        assert!(observed.resources.is_idle());
        let path = f
            .root
            .join("history-checkpoints/objects")
            .join(first["bundle"]["digest"].as_str().unwrap());
        std::fs::write(path, b"damaged").unwrap();
        assert!(
            read(&f.app, &f.issuer, &session, head["revision"].clone())
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
    let mut f = Fixture::new("http://127.0.0.1:1/v1", None).await;
    let session = f.create("Explicit management only").await;
    let original = input(&f, &session, Value::Null).await;
    let model = f
        .issuer
        .issue_with(
            Identity::Agent {
                invocation: maka_agent_facts::event::Invocation {
                    session_id: session.clone(),
                    turn_id: "t".into(),
                    run_id: "r".into(),
                    invocation_id: "i".into(),
                },
                operation_id: None,
            },
            true,
            CancellationToken::new(),
        )
        .unwrap();
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
            "historyCheckpointReceipt",
            json!({"reference":reference,"input":original})
        )
        .await
        .unwrap_err(),
        "recovery explicitly denied"
    );
    close(&f).await;
}

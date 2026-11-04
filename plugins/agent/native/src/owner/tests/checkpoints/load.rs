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

async fn load(f: &Fixture, input: Value, operation: Uuid) -> (RecoveryRef, Receipt) {
    let client = f.app.client();
    let prepared = client
        .prepare_mutation(
            f.binding(2).await,
            "loadHistoryCheckpoint".into(),
            input,
            scope(&f.issuer, true),
            operation,
            Attachments::new().into(),
        )
        .await
        .unwrap();
    let reference = prepared.reference().clone();
    let result = client.mutate_owned(prepared).await.unwrap().result().await;
    (reference, result.receipt)
}
fn loaded(receipt: Receipt) -> Value {
    let Receipt::Recorded {
        outcome: OperationOutcome::Returned { value },
        ..
    } = receipt
    else {
        panic!("{receipt:?}");
    };
    assert_eq!(value["state"]["kind"], "ready");
    value
}

#[tokio::test]
async fn exact_load_reads_frozen_history_and_artifacts_without_changing_live_session() {
    tokio::time::timeout(Duration::from_secs(90),async {
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f=Fixture::new(&format!("http://{}/v1",listener.local_addr().unwrap()),None).await;
        let session=f.create("Load checkpoint").await;
        let bytes=vec![73;65539];
        attachments::upload(&f,&session,"before.txt",&bytes,Uuid::new_v4()).await.unwrap();
        turn(&f,&listener,&session,"frozen response").await;
        let checkpoint=published(publish(&f,input(&f,&session,Value::Null).await,Uuid::new_v4()).await.1);
        let head=checkpoint["state"]["head"].clone();
        turn(&f,&listener,&session,"later live response").await;
        attachments::upload(&f,&session,"after.txt",b"only live",Uuid::new_v4()).await.unwrap();
        let original=json!({"sessionId":session,"revision":head["revision"]});
        let (reference,receipt)=load(&f,original.clone(),Uuid::new_v4()).await;
        let result=loaded(receipt);
        assert_eq!(result["head"],head);
        let inspection=result["inspection"].clone();
        let page=f.query("loadedHistoryCheckpointHistory",json!({"inspection":inspection,"sessionId":session,"position":{"kind":"start"}})).await.unwrap();
        let text=page.to_string();assert!(text.contains("frozen response"));assert!(!text.contains("later live response"));
        let live=f.query("history",json!({"sessionId":session,"position":{"kind":"tail"}})).await.unwrap();
        assert!(live.to_string().contains("later live response"));
        let artifacts=f.query("loadedHistoryCheckpointArtifacts",json!({"inspection":inspection,"sessionId":session,"offset":0})).await.unwrap();
        assert_eq!(artifacts["artifacts"].as_array().unwrap().len(),1);
        let artifact=&artifacts["artifacts"][0];assert_eq!(artifact["name"],"before.txt");
        let mut actual=Vec::new();
        while actual.len()<bytes.len() {
            let chunk=f.query("loadedHistoryCheckpointArtifact",json!({"inspection":inspection,"sessionId":session,"artifactId":artifact["id"],"offset":actual.len()})).await.unwrap();
            let chunk=STANDARD.decode(chunk["data"].as_str().unwrap()).unwrap();assert!(chunk.len()<=32768);actual.extend(chunk);
        }
        assert_eq!(actual,bytes);
        let current=published(publish(&f,input(&f,&session,head["revision"].clone()).await,Uuid::new_v4()).await.1);
        assert_ne!(current["state"]["head"],head);
        assert_eq!(f.query("historyCheckpointLoadReceipt",json!({"reference":reference,"input":original})).await.unwrap()["load"],result);
        assert_eq!(loaded(load(&f,original.clone(),reference.operation).await.1),result);
        assert!(f.mutation(2,"loadHistoryCheckpoint",original,Uuid::new_v4()).await.is_err());
        let page=f.query("loadedHistoryCheckpointHistory",json!({"inspection":inspection,"sessionId":session,"position":{"kind":"start"}})).await.unwrap();
        assert!(page.to_string().contains("frozen response"));
        let live_after=f.query("history",json!({"sessionId":session,"position":{"kind":"tail"}})).await.unwrap();
        assert_eq!(live_after,live);
        close(&f).await;
    }).await.unwrap();
}

#[tokio::test]
async fn inspection_rejects_foreign_members_namespaces_model_scope_and_changed_recovery_input() {
    let f = Fixture::new("http://127.0.0.1:1/v1", None).await;
    let session = f.create("Inspection owner").await;
    let other = f.create("Unrelated live session").await;
    let checkpoint = published(
        publish(&f, input(&f, &session, Value::Null).await, Uuid::new_v4())
            .await
            .1,
    );
    let original = json!({"sessionId":session,"revision":checkpoint["state"]["head"]["revision"]});
    let (reference, receipt) = load(&f, original.clone(), Uuid::new_v4()).await;
    let result = loaded(receipt);
    let inspection = result["inspection"].clone();
    assert!(
        f.query(
            "loadedHistoryCheckpointHistory",
            json!({"inspection":inspection,"sessionId":other,"position":{"kind":"tail"}})
        )
        .await
        .is_err()
    );
    let mut foreign = inspection.clone();
    foreign["sourceSessionId"] = json!("unowned");
    assert!(
        f.query(
            "loadedHistoryCheckpointArtifacts",
            json!({"inspection":foreign,"sessionId":session,"offset":0})
        )
        .await
        .is_err()
    );
    let mut changed = original.clone();
    changed["revision"] = json!(Uuid::new_v4());
    assert!(
        f.query(
            "historyCheckpointLoadReceipt",
            json!({"reference":reference,"input":changed})
        )
        .await
        .is_err()
    );
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
    let error = f
        .app
        .client()
        .start(
            f.binding(2).await,
            "loadedHistoryCheckpointArtifacts".into(),
            json!({"inspection":inspection,"sessionId":session,"offset":0}),
            model,
            Attachments::new().into(),
        )
        .await
        .unwrap()
        .result()
        .await
        .unwrap_err();
    assert_eq!(error, "agent_history_checkpoint_user_action_required");
    close(&f).await;
}

#[tokio::test]
async fn loaded_inspection_survives_root_reopen_and_lost_host_settlement() {
    tokio::time::timeout(Duration::from_secs(90),async {
        let f=Fixture::new("http://127.0.0.1:1/v1",None).await;
        let session=f.create("Loaded before Host settlement").await;
        attachments::upload(&f,&session,"kept.txt",b"persisted inspection",Uuid::new_v4()).await.unwrap();
        let checkpoint=published(publish(&f,input(&f,&session,Value::Null).await,Uuid::new_v4()).await.1);
        let original=json!({"sessionId":session,"revision":checkpoint["state"]["head"]["revision"]});
        for path in f.runtime_databases() {
            rusqlite::Connection::open(path).unwrap().execute_batch("CREATE TRIGGER reject_load_host_settlement BEFORE UPDATE ON application_operations WHEN json_extract(OLD.request_json,'$.method')='loadHistoryCheckpoint' BEGIN SELECT RAISE(ABORT,'lost load settlement'); END;").unwrap();
        }
        let (reference,receipt)=load(&f,original.clone(),Uuid::new_v4()).await;
        assert!(matches!(receipt,Receipt::Unavailable{..}));
        let observed=f.query("historyCheckpointLoadReceipt",json!({"reference":reference,"input":original})).await.unwrap();
        assert_eq!(observed["load"]["state"]["kind"],"ready");
        let inspection=observed["load"]["inspection"].clone();
        for path in f.runtime_databases(){rusqlite::Connection::open(path).unwrap().execute_batch("DROP TRIGGER reject_load_host_settlement").unwrap();}
        let deployment=f.app.source().unwrap().deployment;
        close(&f).await;
        let Fixture{_dir,namespaces,root,store,config,app,issuer,owner,services,..}=f;
        drop(app);drop(owner);drop(services);drop(config);
        Arc::try_unwrap(store).ok().expect("all Root owners released").close().await.unwrap();
        let store=Arc::new(RootStore::open(Arc::new(RootOwner::open_existing(&root,&namespaces).unwrap())).await.unwrap());
        let mut registry=NativeRegistry::default();maka_settings_native::provide(&mut registry,bundled_catalog()).unwrap();provide_all(&mut registry).unwrap();
        let app=Application::start_from_store(store.clone(),deployment,registry,issuer.clone(),Arc::new(Grant(issuer.clone(),None)),Some(maka_host_js::factory(Default::default()))).await.unwrap();app.ready().await.unwrap();
        let observed=query(&app,&issuer,"historyCheckpointLoadReceipt",json!({"reference":reference,"input":original})).await.unwrap();
        assert_eq!(observed["load"]["state"]["kind"],"ready");
        assert_eq!(observed["operation"]["outcome"]["kind"],"unresolved");
        assert_eq!(observed["operation"]["cleanup"]["kind"],"unconfirmed");
        let artifacts=query(&app,&issuer,"loadedHistoryCheckpointArtifacts",json!({"inspection":inspection,"sessionId":session,"offset":0})).await.unwrap();assert_eq!(artifacts["artifacts"][0]["name"],"kept.txt");
        app.shutdown().await.unwrap();drop(app);store.shutdown().await.unwrap();drop(store);drop(_dir);
    }).await.unwrap();
}

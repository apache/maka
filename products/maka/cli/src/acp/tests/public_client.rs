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

//! Recovery of a published fork whose Host operation settlement was uncertain.
use super::support::{self, Fixture};
use maka_host_runtime::application::{host::Client, transport::wire::Reply};
use serde_json::json;
use std::time::Duration;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn independent_public_agent_client_finds_published_fork_after_uncertain_host_settlement_and_reopen()
 {
    tokio::time::timeout(Duration::from_secs(60), async {
        use sqlx::Connection;
        let mut fixture = Fixture::open().await;
        let original = support::query(&fixture.native,"agent","observe",json!({"sessionId":fixture.session})).await;
        let mut call = fixture.native.call("agent","fork".into(),json!({
            "sessionId":fixture.session,"expectedRevision":original["session"]["revision"],
            "position":{"kind":"end"},"title":"Published before settlement","labels":[],
        }),Default::default()).await.unwrap();
        call.start().await.unwrap();
        let Reply::Prepared { reference } = call.receive().await.unwrap() else { panic!("fork not prepared"); };
        // Prepared has an identity but no stored operation yet. Install the
        // operation-scoped failpoint in every runtime journal before dispatch;
        // only its selected journal can execute the settlement UPDATE.
        let mut connections = Vec::new();
        for path in fixture.runtime_databases().await {
            let options = sqlx::sqlite::SqliteConnectOptions::new().filename(path);
            let mut connection = sqlx::SqliteConnection::connect_with(&options).await.unwrap();
            // SQLite trigger definitions cannot bind the typed operation UUID.
            sqlx::query(sqlx::AssertSqlSafe(format!("CREATE TRIGGER reject_fork_settlement BEFORE UPDATE OF outcome_json ON application_operations WHEN OLD.operation='{}' BEGIN SELECT RAISE(ABORT,'fork settlement fixture'); END;",reference.operation)))
                .execute(&mut connection).await.unwrap();
            connections.push(connection);
        }
        let Reply::Mutation { reply, cleanup } = call.confirm().await.unwrap() else { panic!("fork returned no receipt"); };
        cleanup.unwrap();
        assert_eq!(reply.reference,*reference);
        let maka_plugin_core::operation::Receipt::Unavailable { diagnostic } = reply.receipt else { panic!("failed settlement must not claim a recorded fork result"); };
        assert!(diagnostic.contains("settlement outcome unknown"),"{diagnostic}");
        call.close().await.unwrap();
        assert!(call.cleanup_confirmed());
        fixture.database_containing(
            "SELECT EXISTS(SELECT 1 FROM application_operations WHERE deployment=? AND namespace=? AND operation=?)",
            &[&reference.source.deployment.to_string(), &serde_json::to_string(&reference.namespace).unwrap(), &reference.operation.to_string()],
        ).await;
        for mut connection in connections {
            sqlx::query("DROP TRIGGER reject_fork_settlement").execute(&mut connection).await.unwrap();
            connection.close().await.unwrap();
        }
        let unresolved = json!({"reference":reference,"receipt":{
            "kind":"recorded","outcome":{"kind":"unresolved"},"cleanup":{"kind":"unconfirmed"},
        }});
        assert_eq!(support::query(&fixture.native,"receipts","read",json!(reference)).await,unresolved);
        let published = support::query(&fixture.native,"agent","forkReceipt",json!({"reference":reference})).await;
        let target = &published["session"];
        assert_eq!(target["title"],"Published before settlement");
        assert_eq!(target["branch"],json!({"sessionId":fixture.session,"position":{"kind":"end"}}));
        assert_ne!(target["id"],original["session"]["id"]);
        let removed = support::mutate(&fixture.native,"agent","changeSession",json!({
            "sessionId":fixture.session,"expectedRevision":original["session"]["revision"],"action":"remove",
        })).await;
        assert_eq!(removed["kind"],"removed");
        fixture.native.close().await.unwrap();
        fixture.client.quit().await.unwrap();
        fixture.server.await.unwrap().unwrap();

        // Reopen the original Root, not another fixture or an adopted snapshot.
        let namespaces = maka_event_log::root::RootNamespaces {
            ownership:fixture._root.path().join("owners"),
            control:fixture._root.path().join("control"),
        };
        let owner = maka_event_log::root::RootOwner::open(fixture.database.parent().unwrap(),&namespaces).unwrap();
        let mut product = crate::application::open_host(owner,Default::default(),crate::application::Roots::Configured(Some(vec![
            maka_host_runtime::DirectoryRootSpec {label:"Test".into(),path:fixture.workspace.to_str().unwrap().into()},
        ])),Some(support::catalog_transport())).await.unwrap();
        let epoch = product.host.epoch();
        assert_ne!(epoch,fixture.epoch);
        #[cfg(unix)]
        let endpoint = fixture._root.path().join("reopened.sock");
        #[cfg(windows)]
        let endpoint = std::path::PathBuf::from(format!(r"\\.\pipe\maka-fork-reopen-{}",uuid::Uuid::new_v4()));
        let listener = maka_host_runtime::ipc::LocalListener::bind(&endpoint).unwrap();
        let stop = tokio_util::sync::CancellationToken::new();
        let _cleanup = stop.clone().drop_guard();
        let server = tokio::spawn(async move {
            let result = product.host.serve_local(listener,stop).await;
            let cleanup = product.shutdown().await.map_err(|error| error.to_string());
            result.and(cleanup)
        });
        let mut client = Client::connect(&endpoint,Some(epoch)).await.unwrap();
        assert_eq!(support::query(&client,"receipts","read",json!(reference)).await,unresolved);
        assert_eq!(support::query(&client,"agent","forkReceipt",json!({"reference":reference})).await,published);
        let current = support::query(&client,"agent","list",json!({"filter":"all","position":{"kind":"start"}})).await;
        assert_eq!(current["sessions"].as_array().unwrap().iter().map(|s|s["id"].clone()).collect::<Vec<_>>(),vec![target["id"].clone()]);
        assert_eq!(support::query(&client,"agent","forkReceipt",json!({"reference":reference})).await,published);
        assert_eq!(support::query(&client,"receipts","read",json!(reference)).await,unresolved);
        let removed = support::mutate(&client,"agent","changeSession",json!({
            "sessionId":target["id"],"expectedRevision":target["revision"],"action":"remove",
        })).await;
        assert_eq!(removed["kind"],"removed");
        assert_eq!(support::query(&client,"agent","forkReceipt",json!({"reference":reference})).await,json!({"session":null}));
        assert_eq!(support::query(&client,"receipts","read",json!(reference)).await,unresolved);
        assert!(fixture.model_requests.try_recv().is_err(),"fork receipt recovery must not start a model");
        client.quit().await.unwrap();
        server.await.unwrap().unwrap();
    }).await.unwrap();
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn published_product_endpoint_exposes_history_checkpoint_and_original_receipt() {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use maka_plugin_core::operation::{OperationOutcome, Receipt};
    tokio::time::timeout(Duration::from_secs(60),async {
        let mut fixture=Fixture::open().await;
        let preview=support::query(&fixture.native,"agent","previewHistoryCheckpoint",json!({"sessionId":fixture.session})).await;
        let input=json!({"sessionId":fixture.session,"expectedRevision":null,"confirmedSubtreeDigest":preview["subtreeDigest"],"workspaceConsistency":null});
        let mut call=fixture.native.call("agent","publishCheckpoint".into(),input.clone(),Default::default()).await.unwrap();
        call.start().await.unwrap();
        let Reply::Prepared {reference}=call.receive().await.unwrap() else {panic!("original operation reference")};
        let Reply::Mutation {reply,cleanup}=call.confirm().await.unwrap() else {panic!("publication receipt")};
        cleanup.unwrap();
        let Receipt::Recorded {outcome:OperationOutcome::Returned {value},..}=reply.receipt else {panic!("publication failed")};
        assert_eq!(value["state"]["kind"],"published");
        call.close().await.unwrap();
        let receipt=support::query(&fixture.native,"agent","checkpointReceipt",json!({"reference":reference,"input":input})).await;
        assert_eq!(receipt["publication"],value);
        let head=support::query(&fixture.native,"agent","historyCheckpointHead",json!({"sessionId":fixture.session})).await;
        assert_eq!(head,value["state"]["head"]);
        let mut stream=fixture.native.call("agent","readHistoryCheckpoint".into(),json!({"sessionId":fixture.session,"revision":head["revision"]}),Default::default()).await.unwrap();
        stream.start().await.unwrap();
        assert!(matches!(stream.receive().await.unwrap(),Reply::Subscribed));
        let mut bytes=Vec::new(); let mut ended=false;
        loop {
            match stream.pull().await.unwrap() {
                Reply::Item {value}=>match value["kind"].as_str().unwrap() {
                    "checkpoint"=>assert_eq!(value["head"],head),
                    "chunk"=>{assert_eq!(value["offset"],bytes.len() as u64); bytes.extend(STANDARD.decode(value["data"].as_str().unwrap()).unwrap());},
                    "end"=>{assert_eq!(value["bytes"],bytes.len() as u64); ended=true;},
                    _=>panic!("{value}"),
                },
                Reply::Finished {result,cleanup}=>{assert!(result.unwrap().is_null());cleanup.unwrap();break;},
                reply=>panic!("{reply:?}"),
            }
        }
        assert!(ended);
        let mut stage=maka_event_log::bundle::StagedBundle::read(bytes.as_slice()).await.unwrap();
        stage.validate_history().await.unwrap();
        stage.close().await.unwrap();
        let load_input=json!({"sessionId":fixture.session,"revision":head["revision"]});
        let mut loading=fixture.native.call("agent","loadHistoryCheckpoint".into(),load_input.clone(),Default::default()).await.unwrap();
        loading.start().await.unwrap();
        let Reply::Prepared {reference:load_ref}=loading.receive().await.unwrap() else {panic!("load not prepared")};
        let Reply::Mutation {reply,cleanup}=loading.confirm().await.unwrap() else {panic!("load not returned")};
        cleanup.unwrap();
        let Receipt::Recorded {outcome:OperationOutcome::Returned {value:loaded},..}=reply.receipt else {panic!("load failed")};
        assert_eq!(loaded["state"]["kind"],"ready");loading.close().await.unwrap();
        let observed=support::query(&fixture.native,"agent","historyCheckpointLoadReceipt",json!({"reference":load_ref,"input":load_input})).await;
        assert_eq!(observed["load"],loaded);
        let history=support::query(&fixture.native,"agent","loadedHistoryCheckpointHistory",json!({"inspection":loaded["inspection"],"sessionId":fixture.session,"position":{"kind":"start"}})).await;
        assert_eq!(history["kind"],"ready");
        assert!(fixture.model_requests.try_recv().is_err(),"checkpoint management never runs the model");
        stream.close().await.unwrap();
        fixture.native.close().await.unwrap(); fixture.client.quit().await.unwrap();
        fixture.server.await.unwrap().unwrap();
    }).await.unwrap();
}

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

#[tokio::test]
async fn cleanup_sql_failure_keeps_recovery_record_without_inventing_root_work() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let (mut f,control,_,configuration)=setup(2).await;
        activate_backend(&mut f,true,None,true,Some(configuration),&[]).await;
        let session=f.create("ACP cleanup persistence fault").await;
        super::super::super::files::change(&f,&session,"danger_full_access",false,false).await;
        let accepted=execute(&f,&session,"wait").await;
        let run = f.delivered_run(&accepted).await;
        let (process,_)=control.accept().await.unwrap();
        let mut process=tokio::io::BufReader::new(process);
        let mut pid=String::new();tokio::io::AsyncBufReadExt::read_line(&mut process,&mut pid).await.unwrap();
        let mut waiting=String::new();tokio::io::AsyncBufReadExt::read_line(&mut process,&mut waiting).await.unwrap();
        assert_eq!(waiting.trim(),"waiting");
        let before=task_heads(&f,&session).await;
        assert_eq!(before.len(),1);
        let raw=rusqlite::Connection::open(f.root.join(maka_event_log::root::ROOT_DATABASE)).unwrap();
        raw.busy_timeout(Duration::from_secs(5)).unwrap();
        // Business and resource progress change the head. Cleanup alone writes
        // either the same unconfirmed head or a physically confirmed marker.
        raw.execute_batch(&format!("CREATE TRIGGER reject_process_cleanup BEFORE UPDATE OF value_json ON plugin_data
            WHEN NEW.package_id='{}' AND NEW.key LIKE 'tasks/%/head'
            AND (NEW.value_json=OLD.value_json OR json_extract(NEW.value_json,'$.cleanup.kind')='confirmed')
            BEGIN SELECT RAISE(ABORT,'injected ACP cleanup SQL fault'); END;",maka_agent_api::acp::IMPLEMENTATION)).unwrap();
        let stopped=f.mutation(2,"stop",json!({"sessionId":session,"runId":run}),Uuid::new_v4()).await.unwrap();
        assert_eq!(stopped["requested"],true);
        f.drained().await;
        let mut eof=String::new();tokio::io::AsyncReadExt::read_to_string(&mut process,&mut eof).await.unwrap();
        let after=task_heads(&f,&session).await;
        assert_eq!(after.len(),1);
        assert_eq!(after[0]["resource_ref"],before[0]["resource_ref"]);
        assert_eq!(after[0]["state"]["kind"],"unknown");
        assert_eq!(after[0]["cleanup"]["kind"],"unconfirmed");
        let failed:i64=raw.query_row("SELECT count(*) FROM application_operations
            WHERE outcome_json LIKE '%injected ACP cleanup SQL fault%'
            AND json_extract(cleanup_json,'$.kind')='confirmed'",[],|row|row.get(0)).unwrap();
        assert!(failed>0,"the provider bookkeeping fault is recorded with actual Root effects drained");
        assert!(f.store.session(&session).await.is_ok());
        let mut changes = f.owner.durable.subscribe().unwrap();
        let observed = loop {
            changes.borrow_and_update();
            let observed = work(&f, &session, &accepted).await;
            if !matches!(observed["execution"]["state"]["kind"].as_str(), Some("admitted" | "running" | "waiting")) { break observed; }
            changes.changed().await.unwrap();
        };
        assert_eq!(observed["execution"]["state"]["kind"],"cancelled");
        { let runs=f.owner.runs.state().await;assert!(!runs.closing);assert!(runs.retained_cleanup.is_empty()); }
        raw.execute_batch("DROP TRIGGER reject_process_cleanup").unwrap();drop(raw);
        f.app.shutdown().await.unwrap();f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

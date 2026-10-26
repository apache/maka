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
async fn cleanup_sql_failure_keeps_recovery_record_after_actual_process_exit() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let (mut f, control, _, configuration) = setup(2).await;
        activate_backend(&mut f, true, None, true, Some(configuration), &[]).await;
        let session = f.create("ACP cleanup persistence fault").await;
        let accepted = execute(&f, &session, "wait").await;
        let permission = super::super::super::files::pending(&f, &session).await;
        super::super::super::files::answer(&f, &permission, Some("session")).await;
        let (process, _) = control.accept().await.unwrap();
        let mut process = tokio::io::BufReader::new(process);
        let mut pid = String::new();
        tokio::io::AsyncBufReadExt::read_line(&mut process, &mut pid)
            .await
            .unwrap();
        let mut waiting = String::new();
        tokio::io::AsyncBufReadExt::read_line(&mut process, &mut waiting)
            .await
            .unwrap();
        assert_eq!(waiting.trim(), "waiting");

        let raw = rusqlite::Connection::open(f.session_database(&session)).unwrap();
        raw.busy_timeout(Duration::from_secs(5)).unwrap();
        let process_id: String = raw.query_row(
            "SELECT id FROM session_processes WHERE session_id=? AND cleaned=0",
            [&session], |row| row.get(0),
        ).unwrap();
        raw.execute_batch(
            "CREATE TRIGGER reject_process_cleanup BEFORE UPDATE OF cleaned ON session_processes
             WHEN NEW.cleaned=1 BEGIN SELECT RAISE(ABORT,'injected process cleanup SQL fault'); END;",
        ).unwrap();
        let stopped = f.mutation(2, "stop", json!({
            "sessionId":session,"invocationId":accepted["invocationId"]
        }), Uuid::new_v4()).await.unwrap();
        assert_eq!(stopped["requested"], true);
        f.drained().await;
        assert!(!std::process::Command::new("/bin/kill")
            .args(["-0", pid.trim()]).output().unwrap().status.success());

        // The failed journal update remains observable. It must not invent
        // unknown physical work after the original process and pipes drained.
        let cleaned: bool = raw.query_row(
            "SELECT cleaned FROM session_processes WHERE id=?", [&process_id],
            |row| row.get(0),
        ).unwrap();
        assert!(!cleaned);
        let failed_cleanup_writes: i64 = f.runtime_databases().iter().map(|path| {
            let db = rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
            db.query_row(
                "SELECT COUNT(*) FROM application_operations
                 WHERE outcome_json LIKE '%injected process cleanup SQL fault%'
                 AND json_extract(cleanup_json,'$.kind')='confirmed'",
                [], |row| row.get::<_, i64>(0),
            ).unwrap()
        }).sum();
        assert!(failed_cleanup_writes > 0, "the cleanup SQL fault was not observed with confirmed physical cleanup");
        assert!(f.store.session(&session).await.is_ok());
        let observed = work(&f, &session, &accepted).await;
        assert!(matches!(observed["execution"]["state"].as_str(), Some("cancelled" | "failed")));
        {
            let runs = f.owner.runs.lock().await;
            assert!(!runs.closing);
            assert!(runs.quarantined.is_empty());
        }

        raw.execute_batch("DROP TRIGGER reject_process_cleanup").unwrap();
        drop(raw);
        f.session(&session).await.clean_session_process(Uuid::parse_str(&process_id).unwrap())
            .await.unwrap();
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

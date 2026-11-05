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

use super::external_support::{configured, input, packet, record, release, setup};
use super::*;
use futures_util::FutureExt;
use tokio::io::BufReader;

#[tokio::test]
async fn native_external_identity_persistence_failure_prevents_prompt_submission() {
    tokio::time::timeout(Duration::from_secs(40),async {
        let (f,listener)=configured("http://127.0.0.1:9/v1",|settings| settings.external.as_mut().unwrap().commands.codex.as_mut().unwrap().args.push("--hold-open".into())).await;
        let session=f.create("Identity write failure").await;
        let accepted=f.mutation(2,"send",input(&session,"must-not-be-prompted"),Uuid::new_v4()).await.unwrap();
        let mut control=BufReader::new(listener.accept().await.unwrap().0);
        packet(&mut control,"before_opened").await;
        assert_eq!(record(&f,&session).await["running"],accepted["invocationId"]);
        let database=f.runtime_database_containing("SELECT count(*) FROM plugin_data WHERE package_id = ?1","maka.agent.external");
        let db=rusqlite::Connection::open(database).unwrap();
        db.execute_batch("CREATE TRIGGER reject_native_opened BEFORE INSERT ON plugin_data WHEN NEW.package_id = 'maka.agent.external' AND json_extract(NEW.value_json, '$.nativeSession') = 'native-fixture-session' BEGIN SELECT RAISE(FAIL, 'injected native identity persistence failure'); END;").unwrap();
        release(&mut control).await;f.drained().await;
        let mut remainder=String::new();tokio::io::AsyncReadExt::read_to_string(&mut control,&mut remainder).await.unwrap();
        assert!(remainder.is_empty(),"no native prompt may follow a failed identity commit: {remainder}");
        assert!(record(&f,&session).await["nativeSession"].is_null());
        assert_eq!(work(&f,&session,&accepted).await["execution"]["state"],"failed");
        assert!(f.prefix(&session,128,1024*1024).await.events.iter().any(|row| matches!(&row.event.fact,maka_agent_facts::event::Fact::InvocationEnded{outcome:maka_agent_facts::event::InvocationOutcome::Failed{message:Some(message),..}} if message.contains("injected native identity persistence failure"))));
        db.execute_batch("DROP TRIGGER reject_native_opened").unwrap();
        assert!(listener.accept().now_or_never().is_none());
        f.app.shutdown().await.unwrap();f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn native_external_exited_worker_with_an_escaped_stdout_holder_returns_unconfirmed_instead_of_hanging()
 {
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        let session = f.create("External inherited pipe custody").await;
        let accepted = f
            .mutation(
                2,
                "send",
                input(&session, "pipe-holder-crash"),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        let mut control = BufReader::new(listener.accept().await.unwrap().0);
        packet(&mut control, "opened").await;
        release(&mut control).await;
        packet(&mut control, "output").await;
        release(&mut control).await;
        let escaped = packet(&mut control, "escaped").await;
        let pid = escaped["pid"].as_u64().unwrap().to_string();
        let result = std::panic::AssertUnwindSafe(async {
            tokio::time::timeout(Duration::from_secs(8), f.drained())
                .await
                .expect("root exit must bound the protocol drain even while stdout remains open");
            assert!(
                tokio::process::Command::new("/bin/kill")
                    .args(["-0", &pid])
                    .status()
                    .await
                    .unwrap()
                    .success(),
                "the pipe holder must still exist when settlement is classified"
            );
            assert_eq!(
                work(&f, &session, &accepted).await["execution"]["state"],
                "failed"
            );
            assert_eq!(
                record(&f, &session).await["running"],
                accepted["invocationId"]
            );
            assert!(
                f.app
                    .shutdown_if_idle()
                    .await
                    .unwrap_err()
                    .contains("cleanup_unconfirmed")
            );
        })
        .catch_unwind()
        .await;
        assert!(
            tokio::process::Command::new("/bin/kill")
                .args(["-KILL", &pid])
                .status()
                .await
                .unwrap()
                .success()
        );
        if let Err(panic) = result {
            std::panic::resume_unwind(panic);
        }
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn claude_clean_preparation_failure_releases_new_uuid_but_preserves_resume_identity() {
    use super::external_support::{input_runtime, record_runtime};
    tokio::time::timeout(Duration::from_secs(60), async {
        let mut paths = None;
        let (f, listener) = configured("http://127.0.0.1:9/v1", |settings| {
            let command = settings
                .external
                .as_mut()
                .unwrap()
                .commands
                .claude
                .as_mut()
                .unwrap();
            let node = std::path::Path::new(&command.env["PATH"]).join(&command.executable);
            let launch = settings.workspace_roots[0]
                .path
                .join("claude-fixture-launch");
            command.executable = launch.to_str().unwrap().into();
            paths = Some((node, launch));
        })
        .await;
        let (node, launch) = paths.unwrap();
        let session = f.create("Claude preparation recovery").await;
        let failed = f
            .mutation(
                2,
                "send",
                input_runtime(&session, "claude", "complete"),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        f.drained().await;
        assert_eq!(
            work(&f, &session, &failed).await["execution"]["state"],
            "failed"
        );
        let record = record_runtime(&f, &session, "claude").await;
        assert!(record["nativeSession"].is_null());
        assert!(record["running"].is_null());
        assert!(listener.accept().now_or_never().is_none());
        let mut original: Option<Value> = None;
        for resume in [false, true] {
            std::os::unix::fs::symlink(&node, &launch).unwrap();
            let accepted = f
                .mutation(
                    2,
                    "send",
                    input_runtime(&session, "claude", "complete"),
                    Uuid::new_v4(),
                )
                .await
                .unwrap();
            let mut control = BufReader::new(listener.accept().await.unwrap().0);
            let opened = packet(&mut control, "opened").await;
            if resume {
                assert_eq!(
                    opened["request"]["resume"],
                    original.as_ref().unwrap().clone()
                );
            } else {
                assert!(opened["request"].get("resume").is_none());
            }
            release(&mut control).await;
            packet(&mut control, "output").await;
            release(&mut control).await;
            packet(&mut control, "terminal").await;
            release(&mut control).await;
            f.drained().await;
            assert_eq!(
                work(&f, &session, &accepted).await["execution"]["state"],
                "completed"
            );
            let record = record_runtime(&f, &session, "claude").await;
            if original.is_none() {
                original = Some(record["nativeSession"].clone());
            }
            std::fs::remove_file(&launch).unwrap();
            if !resume {
                let failed = f
                    .mutation(
                        2,
                        "send",
                        input_runtime(&session, "claude", "complete"),
                        Uuid::new_v4(),
                    )
                    .await
                    .unwrap();
                f.drained().await;
                assert_eq!(
                    work(&f, &session, &failed).await["execution"]["state"],
                    "failed"
                );
                let record = record_runtime(&f, &session, "claude").await;
                assert_eq!(record["nativeSession"], original.as_ref().unwrap().clone());
                assert!(record["running"].is_null());
            }
        }
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn claude_api_error_with_duration_settles_failed_and_allows_same_native_session_followup() {
    use super::external_support::{input_runtime, record_runtime};
    tokio::time::timeout(Duration::from_secs(60),async {
        let (f,listener)=setup("http://127.0.0.1:9/v1").await;
        let session=f.create("Claude API failure recovery").await;
        let mut original=None;
        for message in ["api-error","complete"] {
            let accepted=f.mutation(2,"send",input_runtime(&session,"claude",message),Uuid::new_v4()).await.unwrap();
            let mut control=BufReader::new(listener.accept().await.unwrap().0);
            let opened=packet(&mut control,"opened").await;
            if let Some(original)=&original {assert_eq!(&opened["request"]["resume"],original);}
            release(&mut control).await;packet(&mut control,"output").await;
            assert_eq!(record_runtime(&f,&session,"claude").await["running"],accepted["invocationId"],"the API-error row alone cannot release the running fence");
            release(&mut control).await;packet(&mut control,"terminal").await;release(&mut control).await;f.drained().await;
            assert_eq!(work(&f,&session,&accepted).await["execution"]["state"],if message=="api-error" {"failed"} else {"completed"});
            let record=record_runtime(&f,&session,"claude").await;
            assert!(record["running"].is_null());
            if let Some(original)=&original {assert_eq!(&record["nativeSession"],original);}else{original=Some(record["nativeSession"].clone());}
        }
        assert!(f.prefix(&session,128,1024*1024).await.events.iter().any(|row| matches!(&row.event.fact,maka_agent_facts::event::Fact::InvocationEnded{outcome:maka_agent_facts::event::InvocationOutcome::Failed{message:Some(message),..}} if message.contains("FIXTURE_API_FAILURE"))));
        f.app.shutdown().await.unwrap();f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

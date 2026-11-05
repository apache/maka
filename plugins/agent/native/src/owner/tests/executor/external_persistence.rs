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
        let database=f.runtime_database_containing("SELECT count(*) FROM plugin_data WHERE package_id = ?1","maka.agent.oar");
        let db=rusqlite::Connection::open(database).unwrap();
        db.execute_batch("CREATE TRIGGER reject_native_opened BEFORE INSERT ON plugin_data WHEN NEW.package_id = 'maka.agent.oar' AND json_extract(NEW.value_json, '$.nativeSession') = 'native-fixture-session' BEGIN SELECT RAISE(FAIL, 'injected native identity persistence failure'); END;").unwrap();
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

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

use super::oar_support::{input, packet, record, release, setup};
use super::*;
use crate::owner::tests::attachments::upload;
use futures_util::FutureExt;
use std::path::PathBuf;
use tokio::io::BufReader;

#[tokio::test]
async fn native_oar_opened_persistence_failure_cancels_without_ack_and_requires_disposal() {
    tokio::time::timeout(Duration::from_secs(60), async {
        for confirmed in [true, false] {
            let (f, listener) = setup("http://127.0.0.1:9/v1").await;
            let session = f.create("OAR opened storage failure").await;
            let mut bytes = std::io::Cursor::new(Vec::new());
            image::DynamicImage::new_rgb8(2, 3).write_to(&mut bytes, image::ImageFormat::Png).unwrap();
            let bytes = bytes.into_inner();
            let image = upload(&f, &session, "image.png", &bytes, Uuid::new_v4()).await.unwrap();
            let mut request = input(&session, if confirmed { "identity-failure" } else { "identity-failure-crash" });
            request["attachments"] = json!([image["attachment"]["id"]]);
            let operation = Uuid::new_v4();
            let accepted = f.mutation(2, "send", request.clone(), operation).await.unwrap();
            assert_eq!(accepted["kind"], "started", "{accepted}");
            let mut control = BufReader::new(listener.accept().await.unwrap().0);
            let before = packet(&mut control, "before_opened").await;
            let path = PathBuf::from(before["request"]["images"][0]["path"].as_str().unwrap());
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
            assert_eq!(record(&f, &session).await["running"], accepted["invocationId"]);

            // Fail only the actual opened write; start and ready remain valid transactions.
            let database = f.runtime_database_containing("SELECT count(*) FROM plugin_data WHERE package_id = ?1", "maka.agent.oar");
            let db = rusqlite::Connection::open(database).unwrap();
            db.execute_batch("CREATE TRIGGER reject_oar_opened BEFORE INSERT ON plugin_data
                WHEN NEW.package_id = 'maka.agent.oar' AND json_extract(NEW.value_json, '$.nativeSession') = 'native-fixture-session'
                BEGIN SELECT RAISE(FAIL, 'injected OAR opened persistence failure'); END;").unwrap();
            release(&mut control).await;
            let cancelled = packet(&mut control, "cancelled_without_prompt").await;
            assert_eq!(cancelled["control"]["kind"], "cancel");
            if confirmed {
                packet(&mut control, "terminal").await;
                assert_eq!(std::fs::read(&path).unwrap(), bytes, "disposal receipt alone is not process exit");
                assert_eq!(record(&f, &session).await["running"], accepted["invocationId"]);
                release(&mut control).await;
            }
            f.drained().await;
            let settled = work(&f, &session, &accepted).await;
            assert_eq!(settled["execution"]["state"], "failed", "{settled}");
            assert_eq!(f.mutation(2, "send", request, operation).await.unwrap(), accepted);
            assert!(listener.accept().now_or_never().is_none(), "original receipt never redispatches");
            assert!(record(&f, &session).await["nativeSession"].is_null(), "failed identity was never committed");
            db.execute_batch("DROP TRIGGER reject_oar_opened").unwrap();
            drop(db);
            if confirmed {
                assert!(record(&f, &session).await["running"].is_null());
                assert!(!path.parent().unwrap().exists(), "confirmed disposal and exit release image custody");
                let prefix = f.prefix(&session, 128, 1024 * 1024).await;
                assert!(prefix.events.iter().any(|row| matches!(&row.event.fact,
                    maka_agent_facts::event::Fact::InvocationEnded { outcome: maka_agent_facts::event::InvocationOutcome::Failed { message: Some(message), .. }, .. }
                    if message.contains("injected OAR opened persistence failure"))), "original persistence error must survive cleanup");
                let retried = f.mutation(2, "send", input(&session, "complete"), Uuid::new_v4()).await.unwrap();
                assert_eq!(retried["kind"], "started", "{retried}");
                let mut next = BufReader::new(listener.accept().await.unwrap().0);
                let opened = packet(&mut next, "opened").await;
                assert!(opened["request"].get("resume").is_none());
                release(&mut next).await;
                packet(&mut next, "output").await;
                release(&mut next).await;
                packet(&mut next, "terminal").await;
                release(&mut next).await;
                f.drained().await;
                assert_eq!(work(&f, &session, &retried).await["execution"]["state"], "completed");
                f.app.shutdown().await.unwrap();
            } else {
                assert_eq!(record(&f, &session).await["running"], accepted["invocationId"]);
                assert_eq!(std::fs::read(&path).unwrap(), bytes);
                assert!(f.app.shutdown_if_idle().await.unwrap_err().contains("cleanup_unconfirmed"));
                // This fixture exited without descendants, but production cannot infer disposal from that.
                std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
            }
            f.config.shutdown().await.unwrap();
        }
    }).await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn native_oar_exited_worker_with_an_escaped_stdout_holder_returns_unconfirmed_instead_of_hanging()
 {
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        let session = f.create("OAR inherited pipe custody").await;
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

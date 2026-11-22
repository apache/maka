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

use super::{
    call,
    host::{Host, Sandbox},
};
use maka_app_client::{Client, Journal};
use maka_host_runtime::application::host::Client as HostClient;
use maka_plugin_core::operation::{OperationOutcome, OperationResult, Receipt, RecoveryRef};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;

pub(super) struct Interrupted {
    attempt: Uuid,
    reference: RecoveryRef,
    before: Value,
    pub(super) path: PathBuf,
}

async fn journal_client(sandbox: &Sandbox, host: &HostClient, address: &Path) -> Client {
    Client::new(
        HostClient::connect(address, Some(host.epoch()))
            .await
            .unwrap(),
        Journal::open(&sandbox.journal).await.unwrap(),
        "receipts".into(),
    )
    .unwrap()
}

pub(super) async fn interrupt(
    sandbox: &Sandbox,
    host: &mut Host,
    first: &HostClient,
    address: &Path,
    input: &Value,
    nonce: &str,
) -> Interrupted {
    let before = call(
        first,
        "agent",
        "observe",
        json!({"sessionId":input["checkpoint"]["sessionId"]}),
        Default::default(),
    )
    .await;
    let client = journal_client(sandbox, first, address).await;
    let attempt = Uuid::new_v4();
    let mutation = client
        .mutation(
            attempt,
            "agent",
            "restoreSessionCheckpoint",
            input.clone(),
            Default::default(),
            None,
            Value::Null,
        )
        .await
        .unwrap();
    let reference = mutation.prepare().await.unwrap().reference.unwrap();
    let db = Connection::open(sandbox.root.join(maka_event_log::root::ROOT_DATABASE)).unwrap();
    // These guards live only in the fixture Root. Pin both durable writes to
    // the pre-commit state even if the Host outruns the observing process.
    db.execute_batch(&format!(
        "CREATE TRIGGER hold_binding BEFORE UPDATE OF result_json ON checkpoint_workspace_restores
         WHEN json_extract(OLD.request_json,'$.operation.operation')='{id}'
         BEGIN SELECT RAISE(ABORT,'hold restore binding'); END;
         CREATE TRIGGER hold_settlement BEFORE UPDATE OF outcome_json ON application_operations
         WHEN OLD.operation='{id}' BEGIN SELECT RAISE(ABORT,'hold restore settlement'); END;",
        id = reference.operation
    ))
    .unwrap();
    let prepared =
        async {
            loop {
                let path: Option<String> = db.query_row(
                "SELECT json_extract(prepared_json,'$.path') FROM checkpoint_workspace_restores
                 WHERE json_extract(request_json,'$.operation.operation')=?
                 AND directory_identity_json IS NOT NULL AND result_json IS NULL",
                [reference.operation.to_string()], |row| row.get(0)
            ).optional().unwrap();
                if let Some(path) = path {
                    let path = PathBuf::from(path);
                    assert_eq!(
                        std::fs::read_to_string(path.join("effects.log")).unwrap(),
                        format!("{nonce}\n")
                    );
                    return path;
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        };
    let confirming = mutation.confirm();
    tokio::pin!(confirming);
    let path = tokio::time::timeout(Duration::from_secs(30), async {
        // A completed confirmation, including an ordinary failure, cannot
        // stand in for losing the process during this original restore.
        tokio::select! {
            biased;
            reply = &mut confirming => panic!("restore finished before SIGKILL: {reply:?}"),
            path = prepared => path,
        }
    })
    .await
    .expect("restore did not reach its durable prepared directory");
    host.sigkill().await.unwrap();
    if let Ok(reply) = confirming.await {
        assert_eq!(reply.reference, reference);
        assert!(
            !matches!(
                reply.receipt,
                Receipt::Recorded {
                    outcome: OperationOutcome::Returned { .. },
                    ..
                }
            ),
            "{reply:?}"
        );
    }
    // The successor and both read-only receipt queries run without fault injection.
    db.execute_batch("DROP TRIGGER hold_binding; DROP TRIGGER hold_settlement;")
        .unwrap();
    Interrupted {
        attempt,
        reference,
        before: before["session"].clone(),
        path,
    }
}

impl Interrupted {
    pub(super) async fn check_recovery(
        &self,
        sandbox: &Sandbox,
        host: &HostClient,
        address: &Path,
        input: &Value,
    ) {
        let recovery = journal_client(sandbox, host, address).await;
        let original = recovery.operation(self.attempt).await.unwrap();
        assert_eq!(original.reference.as_ref(), Some(&self.reference));
        let receipt = recovery.recover(self.attempt).await.unwrap();
        assert_eq!(receipt.reference, self.reference);
        assert!(
            matches!(
                receipt.receipt,
                Receipt::Recorded {
                    outcome: OperationOutcome::Unresolved,
                    ..
                }
            ),
            "{receipt:?}"
        );
        let query = json!({"reference":self.reference,"input":input});
        let read = || {
            call(
                host,
                "agent",
                "sessionCheckpointRestoreReceipt",
                query.clone(),
                Default::default(),
            )
        };
        let evidence = read().await;
        assert_eq!(evidence["operation"]["reference"], query["reference"]);
        assert_eq!(evidence["operation"]["outcome"]["kind"], "unresolved");
        assert_eq!(evidence.get("restore"), Some(&Value::Null));
        assert_eq!(read().await, evidence);
        let current = call(
            host,
            "agent",
            "observe",
            json!({"sessionId":self.before["id"]}),
            Default::default(),
        )
        .await;
        assert_eq!(current["session"]["revision"], self.before["revision"]);
        assert_eq!(current["session"]["workspace"], self.before["workspace"]);
        assert_eq!(current["session"]["activity"], "idle");
        let parent = Path::new(input["parent"].as_str().unwrap());
        let entries: Vec<_> = std::fs::read_dir(parent)
            .unwrap()
            .map(|e| e.unwrap().path().canonicalize().unwrap())
            .collect();
        assert_eq!(
            entries,
            [self.path.canonicalize().unwrap()],
            "receipt recovery created another restore directory"
        );
        recovery.close().await.unwrap();
    }
}

/// Even while r1 is still the published Head, the original restore input
/// cannot overwrite history after the successor has completed another turn.
pub(super) async fn check_stale(
    sandbox: &Sandbox,
    host: &HostClient,
    address: &Path,
    input: &Value,
) {
    let client = journal_client(sandbox, host, address).await;
    let mutation = client
        .mutation(
            Uuid::new_v4(),
            "agent",
            "restoreSessionCheckpoint",
            input.clone(),
            Default::default(),
            None,
            Value::Null,
        )
        .await
        .unwrap();
    mutation.prepare().await.unwrap();
    let reply = mutation.confirm().await.unwrap();
    match reply.receipt {
        Receipt::Recorded {
            outcome:
                OperationOutcome::Unknown { diagnostic }
                | OperationOutcome::Returned {
                    result: OperationResult::Failure { diagnostic },
                },
            ..
        } => assert_eq!(diagnostic, "agent_history_checkpoint_unavailable"),
        other => panic!("stale restore did not report its original rejection: {other:?}"),
    }
    client.close().await.unwrap();
}

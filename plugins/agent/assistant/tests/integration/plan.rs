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

use crate::support::{Storage, draft};
use maka_assistant::plan::{Command, Error, repository::Repository};
use maka_capabilities::storage::StoreError;
use maka_event_log::EventLog;
use std::sync::{Arc, atomic::Ordering};

#[tokio::test]
async fn frozen_native_approval_and_business_receipt_share_the_original_plan_cas() {
    use maka_assistant::plan::Request;
    use maka_capabilities::storage::{Data, Mutation, Store};
    use serde_json::json;
    let temp = tempfile::tempdir().unwrap();
    let log = Arc::new(
        EventLog::open(&temp.path().join("native-plan.sqlite"))
            .await
            .unwrap(),
    );
    let storage = Storage::new(log);
    let repo = Repository::<serde_json::Value>::new(storage.clone(), "native", "session").unwrap();
    let proposed = repo
        .apply(
            &Request {
                operation_id: "propose".into(),
                expected_revision: 0,
                command: Command::Propose {
                    turn_id: "planning".into(),
                    artifact: draft(),
                },
            },
            1,
        )
        .await
        .unwrap();
    let proposal = proposed.proposal.unwrap();
    let frozen = json!({"model":"reviewed-model","boundary":7,"tools":["Read","update_plan"]});
    let request = Request {
        operation_id: "approve".into(),
        expected_revision: proposed.revision,
        command: Command::Approve {
            language: maka_agent_facts::language::Language::En,
            proposal_id: proposal.id.clone(),
            proposal_revision: proposal.revision,
            behavior: "maka.plan.execute".to_owned().try_into().unwrap(),
            grant: frozen.clone(),
        },
    };
    let receipt = |key: &str| Mutation {
        key: key.into(),
        expected_revision: None,
        data: Data::Present(json!({"revision":2})),
    };
    storage.lose_reply.store(true, Ordering::SeqCst);
    assert!(matches!(
        repo.apply_with(&request, 2, vec![receipt("host-approval")])
            .await,
        Err(Error::Storage(StoreError::OutcomeUnknown(_)))
    ));
    assert!(
        storage
            .read("host-approval".into())
            .await
            .unwrap()
            .is_some()
    );
    let recovered = repo.receipt(&request).await.unwrap().unwrap();
    assert_eq!(recovered.execution.as_ref().unwrap().grant, frozen);
    assert_eq!(
        recovered.execution.as_ref().unwrap().request.operation_id,
        repo.current()
            .await
            .unwrap()
            .execution
            .unwrap()
            .request
            .operation_id
    );
    let stale = Request {
        operation_id: "stale".into(),
        expected_revision: 1,
        command: Command::Abandon {
            proposal_id: proposal.id,
        },
    };
    assert!(matches!(
        repo.apply_with(&stale, 3, vec![receipt("stale-host")])
            .await,
        Err(Error::Conflict)
    ));
    assert!(storage.read("stale-host".into()).await.unwrap().is_none());
}

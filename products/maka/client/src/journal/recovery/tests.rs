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

use crate::journal::{DraftEdit, DraftKey, DraftReference, Journal, Operation, UploadReference};
use crate::{CONTROL_KIND, SETTINGS_KIND, ServiceOwner};
use maka_plugin_core::{
    composition::InstanceId,
    deployment::DeploymentRef,
    operation::{OperationCleanup, OperationOutcome, Receipt},
};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use uuid::Uuid;

#[derive(Clone, Copy, Debug)]
enum List {
    Drafts,
    Uploads,
    Controls,
    Terminals,
    Settings,
}
const LISTS: [List; 5] = [
    List::Drafts,
    List::Uploads,
    List::Controls,
    List::Terminals,
    List::Settings,
];
impl List {
    async fn read(self, journal: &Journal, key: &DraftKey, host: &DeploymentRef) -> Vec<Uuid> {
        let operations = match self {
            Self::Drafts => journal.pending(host, key).await,
            Self::Uploads => journal.pending_uploads(host, key).await,
            Self::Controls => journal.pending_controls(host, &service_owner(key)).await,
            Self::Terminals => {
                journal
                    .pending_terminals(host, &key.session_id, &service_owner(key))
                    .await
            }
            Self::Settings => journal.pending_settings(host, &[service_owner(key)]).await,
        }
        .unwrap();
        operations
            .into_iter()
            .map(|operation| operation.id)
            .collect()
    }
    async fn steps(self, journal: &Journal, key: &DraftKey, host: &DeploymentRef) -> usize {
        let count = Arc::new(AtomicUsize::new(0));
        let observed = count.clone();
        let mut connection = journal.pool.acquire().await.unwrap();
        connection
            .lock_handle()
            .await
            .unwrap()
            .set_progress_handler(1, move || {
                observed.fetch_add(1, Ordering::Relaxed);
                true
            });
        drop(connection);
        let operations = self.read(journal, key, host).await;
        let mut connection = journal.pool.acquire().await.unwrap();
        connection
            .lock_handle()
            .await
            .unwrap()
            .remove_progress_handler();
        assert!(operations.is_empty(), "{self:?}: {operations:?}");
        count.load(Ordering::Relaxed)
    }
}
fn owner() -> (DeploymentRef, DraftKey) {
    let host = DeploymentRef {
        state_domain: "host".into(),
        deployment: Uuid::from_u128(1),
        revision: 1,
    };
    let key = DraftKey {
        state_domain: host.state_domain.clone(),
        deployment: host.deployment,
        namespace: InstanceId(vec![Uuid::from_u128(2)]),
        export: "Agent".into(),
        session_id: "session".into(),
        editor_id: "editor".into(),
    };
    (host, key)
}
fn service_owner(key: &DraftKey) -> ServiceOwner {
    ServiceOwner {
        namespace: key.namespace.clone(),
        export: key.export.clone(),
    }
}
fn operation(list: List, id: u128, host: &DeploymentRef, key: &DraftKey) -> Operation {
    let mut operation = Operation {
        id: Uuid::from_u128(id),
        host: host.clone(),
        endpoint: "agent".into(),
        method: "create".into(),
        session_id: None,
        correlation: Value::Null,
        draft: None,
        upload: None,
        abandoned: false,
        reference: None,
        receipt: None,
    };
    match list {
        List::Drafts => {
            operation.method = "send".into();
            operation.session_id = Some(key.session_id.clone());
            operation.draft = Some(DraftReference {
                key: key.clone(),
                revision: 1,
            });
        }
        List::Uploads => {
            operation.method = "uploadAttachment".into();
            operation.session_id = Some(key.session_id.clone());
            operation.upload = Some(UploadReference {
                key: key.clone(),
                name: "file".into(),
                bytes: 4,
                digest: "digest".into(),
            });
        }
        List::Controls => {
            operation.correlation = json!({"kind":CONTROL_KIND,"owner":service_owner(key)})
        }
        List::Terminals => {
            operation.endpoint = "terminal".into();
            operation.method = "start".into();
            operation.session_id = Some(key.session_id.clone());
            operation.correlation = json!({"kind":"terminal","owner":service_owner(key)});
        }
        List::Settings => {
            operation.endpoint = "settings".into();
            operation.correlation = json!({"kind":SETTINGS_KIND,"owner":service_owner(key)});
        }
    }
    operation
}
fn returned(cleanup: OperationCleanup) -> Receipt {
    Receipt::Recorded {
        outcome: OperationOutcome::Returned {
            value: json!({"kind":"rejected"}),
        },
        cleanup,
    }
}

#[tokio::test]
async fn every_recovery_list_skips_resolved_history_in_the_actual_journal_path() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("client.db");
    let journal = Journal::open(&path).await.unwrap();
    let (host, key) = owner();
    let contexts: Vec<_> = LISTS
        .into_iter()
        .map(|list| serde_json::to_string(&operation(list, 9, &host, &key)).unwrap())
        .collect();
    let mut measurements = Vec::new();
    let mut previous = 0;
    for end in [128, 16_384] {
        sqlx::query("WITH RECURSIVE history(n) AS (SELECT ? UNION ALL SELECT n+1 FROM history WHERE n<?) INSERT INTO operations(id,domain,deployment,context,draft_owner,receipt,upload_adopted) SELECT printf('00000000-0000-0000-0000-%012d',n),?,?,json_set(CASE n%5 WHEN 0 THEN ? WHEN 1 THEN ? WHEN 2 THEN ? WHEN 3 THEN ? ELSE ? END,'$.id',printf('00000000-0000-0000-0000-%012d',n)),CASE WHEN n%5 IN (0,1) THEN ? END,?,1 FROM history")
            .bind(previous + 1).bind(end).bind(&host.state_domain).bind(host.deployment.to_string())
            .bind(&contexts[0]).bind(&contexts[1]).bind(&contexts[2]).bind(&contexts[3]).bind(&contexts[4])
            .bind(serde_json::to_string(&key).unwrap()).bind(serde_json::to_string(&returned(OperationCleanup::Confirmed)).unwrap())
            .execute(&journal.pool).await.unwrap();
        // Warm statement preparation before counting execution work.
        for list in LISTS {
            assert!(list.read(&journal, &key, &host).await.is_empty());
        }
        let mut stage = Vec::new();
        for list in LISTS {
            let steps = list.steps(&journal, &key, &host).await;
            stage.push(steps);
        }
        measurements.push(stage);
        previous = end;
    }
    assert_eq!(
        measurements[0], measurements[1],
        "resolved history must not add recovery VM work"
    );
    journal.pool.close().await;
    drop(journal);
    let reopened = Journal::open(&path).await.unwrap();
    for list in LISTS {
        assert!(list.read(&reopened, &key, &host).await.is_empty());
    }
}

#[tokio::test]
async fn recovery_indexes_preserve_exact_owners_and_eligibility_transitions_after_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("client.db");
    let journal = Journal::open(&path).await.unwrap();
    let (host, key) = owner();
    let mut eligible = Vec::new();
    for (index, list) in LISTS.into_iter().enumerate() {
        let base = 100_000 + index as u128 * 100;
        let mut original = operation(list, base, &host, &key);
        if matches!(list, List::Controls) {
            original.method = "stopComputerApp".into();
            original.session_id = Some(key.session_id.clone());
            original.correlation = json!({"kind":CONTROL_KIND,"owner":service_owner(&key),"operationId":"native-effect-A"});
        }
        journal.reserve(&original).await.unwrap();
        let mut other_domain = original.clone();
        other_domain.id = Uuid::from_u128(base + 1);
        other_domain.host.state_domain = "other".into();
        journal.reserve(&other_domain).await.unwrap();
        let mut other_deployment = original.clone();
        other_deployment.id = Uuid::from_u128(base + 2);
        other_deployment.host.deployment = Uuid::from_u128(999);
        journal.reserve(&other_deployment).await.unwrap();
        let mut abandoned = original.clone();
        abandoned.id = Uuid::from_u128(base + 3);
        journal.reserve(&abandoned).await.unwrap();
        journal.abandon(&host, abandoned.id).await.unwrap();
        if matches!(list, List::Drafts | List::Uploads | List::Terminals) {
            let mut other_key = key.clone();
            other_key.session_id = "another-session".into();
            journal
                .reserve(&operation(list, base + 4, &host, &other_key))
                .await
                .unwrap();
        }
        eligible.push(original);
    }
    // Receipt alone does not settle an upload, and a returned terminal still owns
    // cleanup until its original cleanup acknowledgement is confirmed.
    journal
        .observe(&eligible[1], &returned(OperationCleanup::Confirmed))
        .await
        .unwrap();
    journal
        .observe(&eligible[3], &returned(OperationCleanup::Unconfirmed))
        .await
        .unwrap();
    for (list, original) in LISTS.into_iter().zip(&eligible) {
        assert_eq!(
            list.read(&journal, &key, &host).await,
            vec![original.id],
            "{list:?}"
        );
    }
    journal.pool.close().await;
    drop(journal);
    let mut journal = Journal::open(&path).await.unwrap();
    for (list, original) in LISTS.into_iter().zip(&eligible) {
        assert_eq!(
            list.read(&journal, &key, &host).await,
            vec![original.id],
            "reopened {list:?}"
        );
    }
    journal
        .save_draft(
            &key,
            None,
            DraftEdit {
                text: "adopt rejected upload".into(),
                attachments: vec![],
                settled_uploads: vec![eligible[1].id],
            },
        )
        .await
        .unwrap();
    for index in [0, 2, 3, 4] {
        journal
            .observe(&eligible[index], &returned(OperationCleanup::Confirmed))
            .await
            .unwrap();
    }
    for list in LISTS {
        assert!(
            list.read(&journal, &key, &host).await.is_empty(),
            "settled {list:?}"
        );
    }
    for (id, method) in [(200_000, "setCompactionPrompt"), (200_010, "resume")] {
        let mut prompt = operation(List::Controls, id, &host, &key);
        prompt.method = method.into();
        prompt.session_id = Some(key.session_id.clone());
        prompt.correlation = json!({"kind":CONTROL_KIND,"owner":service_owner(&key)});
        if method == "setCompactionPrompt" {
            prompt.correlation["expectedRevision"] = json!(42);
        }
        journal.reserve(&prompt).await.unwrap();
        journal.pool.close().await;
        drop(journal);
        journal = Journal::open(&path).await.unwrap();
        assert_eq!(
            List::Controls.read(&journal, &key, &host).await,
            vec![prompt.id]
        );
        journal
            .observe(&prompt, &returned(OperationCleanup::Confirmed))
            .await
            .unwrap();
        assert!(List::Controls.read(&journal, &key, &host).await.is_empty());
    }

    let create = operation(List::Controls, 200_001, &host, &key);
    journal.reserve(&create).await.unwrap();
    let mut peer_key = key.clone();
    peer_key.namespace = InstanceId(vec![Uuid::from_u128(3)]);
    assert_eq!(
        List::Controls.read(&journal, &key, &host).await,
        vec![create.id]
    );
    assert!(
        List::Controls
            .read(&journal, &peer_key, &host)
            .await
            .is_empty()
    );
    let settings = operation(List::Settings, 200_002, &host, &key);
    journal.reserve_settings(&settings).await.unwrap();
    let mut same_target = settings.clone();
    same_target.id = Uuid::from_u128(200_003);
    assert_eq!(
        journal.reserve_settings(&same_target).await.unwrap_err(),
        "settings operation already exists or has an unresolved original"
    );
    let peer_settings = operation(List::Settings, 200_004, &host, &peer_key);
    journal.reserve_settings(&peer_settings).await.unwrap();
    assert_eq!(
        List::Settings.read(&journal, &key, &host).await,
        vec![settings.id]
    );
    assert_eq!(
        List::Settings.read(&journal, &peer_key, &host).await,
        vec![peer_settings.id]
    );
    let terminal = operation(List::Terminals, 200_005, &host, &key);
    journal.reserve(&terminal).await.unwrap();
    assert_eq!(
        List::Terminals.read(&journal, &key, &host).await,
        vec![terminal.id]
    );
    assert!(
        List::Terminals
            .read(&journal, &peer_key, &host)
            .await
            .is_empty()
    );
}

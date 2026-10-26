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
use crate::journal::{DraftEdit, DraftKey, DraftReference, Journal, Operation, UploadReference};
use crate::{CONTROL_KIND, CONTROL_METHODS, SETTINGS_KIND, SETTINGS_METHODS};
use maka_plugin_core::{
    composition::InstanceId,
    deployment::DeploymentRef,
    operation::{OperationCleanup, OperationOutcome, Receipt},
};
use serde_json::{Value, json};
use sqlx::Row;
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
    fn sql(self) -> &'static str {
        match self {
            Self::Drafts => DRAFTS,
            Self::Uploads => UPLOADS,
            Self::Controls => CONTROLS,
            Self::Terminals => TERMINALS,
            Self::Settings => SETTINGS,
        }
    }
    async fn read(self, journal: &Journal, key: &DraftKey, host: &DeploymentRef) -> Vec<Uuid> {
        let operations = match self {
            Self::Drafts => journal.pending(host, key).await,
            Self::Uploads => journal.pending_uploads(host, key).await,
            Self::Controls => journal.pending_controls(host).await,
            Self::Terminals => journal.pending_terminals(host, &key.session_id).await,
            Self::Settings => journal.pending_settings(host).await,
        }
        .unwrap();
        operations
            .into_iter()
            .map(|operation| operation.id)
            .collect()
    }
    async fn plan(self, journal: &Journal, key: &DraftKey, host: &DeploymentRef) -> Vec<String> {
        let explain = format!("EXPLAIN QUERY PLAN {}", self.sql());
        // SQL consists only of this fixed prefix and the static production query.
        let mut query = sqlx::query(sqlx::AssertSqlSafe(explain.as_str()))
            .bind(&host.state_domain)
            .bind(host.deployment.to_string());
        query = match self {
            Self::Drafts | Self::Uploads => query.bind(serde_json::to_string(key).unwrap()),
            Self::Controls => {
                query = query.bind(serde_json::to_string(&CONTROL_METHODS).unwrap());
                for _ in 0..6 {
                    query = query.bind(json!({"kind":CONTROL_KIND}).to_string());
                }
                query
            }
            Self::Terminals => query
                .bind(&key.session_id)
                .bind(json!({"kind":"terminal"}).to_string()),
            Self::Settings => query
                .bind(json!({"kind":SETTINGS_KIND}).to_string())
                .bind(serde_json::to_string(&SETTINGS_METHODS).unwrap()),
        };
        query
            .fetch_all(&journal.pool)
            .await
            .unwrap()
            .into_iter()
            .map(|row| row.get("detail"))
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
        List::Controls => operation.correlation = json!({"kind":CONTROL_KIND}),
        List::Terminals => {
            operation.endpoint = "terminal".into();
            operation.method = "start".into();
            operation.session_id = Some(key.session_id.clone());
            operation.correlation = json!({"kind":"terminal"});
        }
        List::Settings => {
            operation.endpoint = "settings".into();
            operation.correlation = json!({"kind":SETTINGS_KIND});
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
            let plan = list.plan(&journal, &key, &host).await;
            eprintln!("{list:?}: history={end} steps={steps} plan={plan:?}");
            assert!(
                plan.iter()
                    .any(|detail| detail
                        .contains("SEARCH operations USING INDEX operations_pending")),
                "{list:?}: {plan:?}"
            );
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
        let original = operation(list, base, &host, &key);
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
    let journal = Journal::open(&path).await.unwrap();
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
}

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

use super::support::SqlStore;
use futures_util::{FutureExt, future::BoxFuture};
use maka_capabilities::storage::Mutation;
use maka_capabilities::storage::Record;
use maka_capabilities::storage::Store;
use maka_capabilities::storage::StoreError;
use maka_event_log::EventLog;
use maka_scheduler::{
    plan::Plan,
    repository::Repository,
    schedule::Schedule,
    task::{Create, Creator, Effect, Notification, Outcome, Run},
};
use std::sync::Arc;
use tokio::sync::Notify;

struct PausedRead {
    inner: SqlStore,
    entered: Arc<Notify>,
    proceed: Arc<Notify>,
}
impl Store for PausedRead {
    fn scan(
        &self,
        query: maka_capabilities::storage::Scan,
    ) -> BoxFuture<'_, Result<maka_capabilities::storage::Page, StoreError>> {
        self.inner.scan(query)
    }
    fn read(&self, key: String) -> BoxFuture<'_, Result<Option<Record>, StoreError>> {
        Box::pin(async move {
            if key == "scheduled-tasks:4:main:task:task-one" {
                self.entered.notify_one();
                self.proceed.notified().await;
            }
            self.inner.read(key).await
        })
    }
    fn batch(&self, mutations: Vec<Mutation>) -> BoxFuture<'_, Result<Vec<Record>, StoreError>> {
        self.inner.batch(mutations)
    }
}

#[tokio::test]
async fn pending_trigger_survives_lost_reply_and_restart_while_stale_writers_and_id_reuse_fail() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("scheduler.sqlite");
    let log = Arc::new(EventLog::open(&path).await.unwrap());
    let repository = Repository::new(Arc::new(SqlStore(log.clone())), "main").unwrap();
    let mut catalog = repository.load().await.unwrap();
    let plan = Plan::create(
        "task-one".into(),
        Create {
            title: "Reminder".into(),
            intent_body: "Read the result".into(),
            schedule: Schedule::Once { run_at: 10_000 },
            effect: Effect::Notify(Notification::Local),
            max_fires: None,
            expires_at: None,
        },
        Creator::User,
        "Asia/Singapore".into(),
        1_000,
    )
    .unwrap();
    repository.save(&mut catalog, plan.clone()).await.unwrap();
    let isolated = Repository::new(Arc::new(SqlStore(log.clone())), "other").unwrap();
    assert!(isolated.load().await.unwrap().plans.is_empty());
    let mut stale = repository.load().await.unwrap();
    let mut triggered = plan.clone();
    triggered.claim(10_000).unwrap();
    // Mark attempted delivery before the external effect; this outcome cannot
    // be cancelled like an explicitly deferred notification.
    triggered.pending.as_mut().unwrap().delivery_started = true;
    let fire = triggered.pending.clone().unwrap();
    let mut commits = log.subscribe_commits();
    // The SQL owner finishes an accepted batch after its response waiter is lost.
    assert!(
        repository
            .save(&mut catalog, triggered.clone())
            .now_or_never()
            .is_none()
    );
    // The independent reader does not fence an accepted writer's commit.
    commits.changed().await.unwrap();
    let committed = repository.load().await.unwrap();
    assert_eq!(committed.plans["task-one"].plan.pending, Some(fire.clone()));
    assert!(matches!(
        repository.save(&mut stale, plan.clone()).await,
        Err(maka_scheduler::Error::Storage(StoreError::Conflict { .. }))
    ));
    log.shutdown().await.unwrap();
    drop(repository);
    drop(log);

    let log = Arc::new(EventLog::open(&path).await.unwrap());
    let repository = Repository::new(Arc::new(SqlStore(log.clone())), "main").unwrap();
    let mut catalog = repository.load().await.unwrap();
    let mut recovered = catalog.plans["task-one"].plan.clone();
    recovered.recover(30_000).unwrap();
    assert_eq!(recovered.claim(30_000).unwrap(), Some(&fire));
    assert!(repository.remove(&mut catalog, "task-one").await.is_err());
    recovered
        .settle(Run {
            id: fire.id,
            at: 30_000,
            outcome: Outcome::Blocked,
            message: "Notification outcome unknown; not replayed".into(),
            session_id: None,
            run_id: None,
        })
        .unwrap();
    repository.save(&mut catalog, recovered).await.unwrap();
    let entered = Arc::new(Notify::new());
    let proceed = Arc::new(Notify::new());
    let concurrent = Repository::new(
        Arc::new(PausedRead {
            inner: SqlStore(log.clone()),
            entered: entered.clone(),
            proceed: proceed.clone(),
        }),
        "main",
    )
    .unwrap();
    let reader = tokio::spawn(async move { concurrent.load().await });
    entered.notified().await;
    repository.remove(&mut catalog, "task-one").await.unwrap();
    proceed.notify_one();
    assert!(matches!(
        reader.await.unwrap(),
        Err(maka_scheduler::Error::Storage(StoreError::Conflict { .. }))
    ));
    assert!(repository.load().await.unwrap().plans.is_empty());
    assert!(repository.save(&mut catalog, plan).await.is_err());
    log.shutdown().await.unwrap();
}

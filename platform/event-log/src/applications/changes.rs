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

//! Deployment-head observations from the same owned store; no grants or package copies.
use super::{EventLog, StoreError, invalid};
use maka_plugin_core::deployment::DeploymentRef;
use sqlx::Row;
use std::sync::{Arc, Weak};

/// A coalescing cursor, not composition authority. The committed SQL head is
/// re-read after every wake, including the first pull and a concurrent commit.
pub struct DeploymentChanges {
    store: Weak<EventLog>,
    stop: Option<tokio_util::sync::CancellationToken>,
    observed: DeploymentRef,
    wakes: tokio::sync::watch::Receiver<u64>,
}
impl EventLog {
    pub fn subscribe_application(
        self: &Arc<Self>,
        observed: DeploymentRef,
    ) -> Result<DeploymentChanges, StoreError> {
        observed.validate().map_err(invalid)?;
        if observed.state_domain != self.application_domain()? {
            return Err(invalid("foreign application state domain"));
        }
        Ok(DeploymentChanges {
            store: Arc::downgrade(self),
            stop: None,
            observed,
            wakes: self.subscribe_commits(),
        })
    }
    /// Head identity only. Exact bytes are loaded separately at that immutable
    /// revision, so unrelated business commits never copy application packages.
    pub async fn application_head(
        &self,
        deployment: uuid::Uuid,
    ) -> Result<Option<DeploymentRef>, StoreError> {
        let state_domain = self.application_domain()?;
        if deployment.is_nil() {
            return Err(invalid("invalid deployment"));
        }
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let row =
                        sqlx::query("SELECT revision FROM application_deployments WHERE id = ?")
                            .bind(deployment.to_string())
                            .fetch_optional(connection)
                            .await?;
                    let Some(row) = row else {
                        return Ok(None);
                    };
                    let revision = u64::try_from(row.try_get::<i64, _>("revision")?)
                        .map_err(|_| invalid("invalid stored application revision"))?;
                    let source = DeploymentRef {
                        state_domain,
                        deployment,
                        revision,
                    };
                    source.validate().map_err(invalid)?;
                    Ok(Some(source))
                })
            })
            .await
    }
}
impl DeploymentChanges {
    pub(crate) fn with_shutdown(mut self, stop: tokio_util::sync::CancellationToken) -> Self {
        self.stop = Some(stop);
        self
    }

    pub async fn next(&mut self) -> Result<DeploymentRef, StoreError> {
        loop {
            // Consume the wake before the SQL read: a commit during the read
            // remains observable if that read did not already include it.
            self.wakes.borrow_and_update();
            if self.stop.as_ref().is_some_and(|stop| stop.is_cancelled()) {
                return Err(StoreError::ConnectionClosed);
            }
            let store = self.store.upgrade().ok_or(StoreError::ConnectionClosed)?;
            let closed = store.connection.close_receipt();
            let source = store
                .application_head(self.observed.deployment)
                .await?
                .ok_or_else(|| invalid("watched deployment not found"))?;
            if source.revision < self.observed.revision {
                return Err(invalid("watched revision exceeds committed head"));
            }
            if source.revision > self.observed.revision {
                self.observed = source.clone();
                return Ok(source);
            }
            drop(store);
            let stopping = async {
                match &self.stop {
                    Some(stop) => stop.cancelled().await,
                    None => std::future::pending::<()>().await,
                }
            };
            tokio::select! {
                biased;
                () = stopping => return Err(StoreError::ConnectionClosed),
                result = closed => {
                    return Err(match result {
                        Ok(()) => StoreError::ConnectionClosed,
                        Err(error) => StoreError::CloseFailed(error),
                    });
                }
                wake = self.wakes.changed() => {
                    wake.map_err(|_| invalid("application commit source closed"))?;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::applications::tests::{input, store};
    use std::time::Duration;

    #[tokio::test]
    async fn actual_sql_shutdown_ends_an_idle_subscription_while_store_handles_survive() {
        let (_dir, store) = store().await;
        let store = Arc::new(store);
        let first = store
            .commit_application(uuid::Uuid::new_v4(), 0, input(), vec![], vec![])
            .await
            .unwrap();
        let mut changes = store.subscribe_application(first).unwrap();
        let mut pending = Box::pin(changes.next());
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut pending)
                .await
                .is_err()
        );
        store.shutdown().await.unwrap();
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(2), pending)
                .await
                .unwrap(),
            Err(StoreError::ConnectionClosed)
        ));
        drop(changes);
        Arc::try_unwrap(store).ok().unwrap().close().await.unwrap();
    }

    #[tokio::test]
    async fn catch_up_coalesces_heads_without_losing_a_commit_or_crossing_deployments() {
        let (_dir, store) = store().await;
        let store = Arc::new(store);
        let id = uuid::Uuid::new_v4();
        let first = store
            .commit_application(id, 0, input(), vec![], vec![])
            .await
            .unwrap();
        let second = store
            .commit_application(id, 1, input(), vec![], vec![])
            .await
            .unwrap();
        let mut changes = store.subscribe_application(first).unwrap();
        assert_eq!(changes.next().await.unwrap(), second);
        let mut pending = Box::pin(changes.next());
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut pending)
                .await
                .is_err()
        );
        store
            .commit_application(uuid::Uuid::new_v4(), 0, input(), vec![], vec![])
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut pending)
                .await
                .is_err()
        );
        store
            .commit_application(id, 2, input(), vec![], vec![])
            .await
            .unwrap();
        let fourth = store
            .commit_application(id, 3, input(), vec![], vec![])
            .await
            .unwrap();
        assert_eq!(pending.await.unwrap(), fourth);
        let mut foreign = fourth.clone();
        foreign.state_domain = uuid::Uuid::new_v4().to_string();
        assert!(store.subscribe_application(foreign).is_err());
        let mut future = fourth;
        future.revision += 1;
        assert!(
            store
                .subscribe_application(future)
                .unwrap()
                .next()
                .await
                .is_err()
        );
        drop(changes);
        Arc::try_unwrap(store).ok().unwrap().close().await.unwrap();
    }
}

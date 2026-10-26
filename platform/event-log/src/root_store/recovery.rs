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

//! Fixed-size startup recovery; all accepted jobs retain the recovery barrier.
use super::*;

enum Recovery {
    Shell(u64),
    Effects,
    Auxiliary,
}
impl RootStore {
    async fn recover_data(&self, kind: Recovery) -> Result<u64, StoreError> {
        self.require_open()?;
        let (guard, released) = self.gates.recovery()?;
        let guard = Arc::new(guard);
        let result = async {
            let mut count = 0u64;
            for owner in &self.partitions {
                let log = owner.scoped(guard.clone());
                let value = match kind {
                    Recovery::Shell(at) => log.recover_shell_runs(at).await?,
                    Recovery::Effects => {
                        log.recover_host_effects().await?;
                        0
                    }
                    Recovery::Auxiliary => {
                        log.recover_auxiliary_models().await?;
                        0
                    }
                };
                count = count.checked_add(value).ok_or_else(|| {
                    StoreError::InvalidTransition("recovery count exhausted".into())
                })?;
            }
            Ok(count)
        }
        .await;
        drop(guard);
        if let Some(lifecycle) = &self.lifecycle {
            tokio::select! {
                result = released => result.map_err(|_| StoreError::OperationUnknown)?,
                closed = lifecycle.wait() => return Err(closed.err().unwrap_or(StoreError::ConnectionClosed)),
            }
        } else {
            released.await.map_err(|_| StoreError::OperationUnknown)?;
        }
        result
    }
    pub async fn recover_shell_runs(&self, now: u64) -> Result<u64, StoreError> {
        self.recover_data(Recovery::Shell(now)).await
    }
    pub async fn recover_host_effects(&self) -> Result<(), StoreError> {
        self.recover_data(Recovery::Effects).await.map(|_| ())
    }
    pub async fn recover_auxiliary_models(&self) -> Result<(), StoreError> {
        self.recover_data(Recovery::Auxiliary).await.map(|_| ())
    }
    pub async fn drain(&self) {
        let mut reported = std::collections::BTreeSet::new();
        loop {
            match self.shutdown().await {
                Ok(()) => return,
                Err(error) => {
                    if reported.insert(error.to_string()) {
                        eprintln!("Root cleanup unconfirmed: {error}");
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
            }
        }
    }
}

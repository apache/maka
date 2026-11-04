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
use futures_util::future::BoxFuture;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

struct NoSettings;
impl storage::Store for NoSettings {
    fn scan(&self, _: storage::Scan) -> BoxFuture<'_, Result<storage::Page, storage::StoreError>> {
        unreachable!()
    }
    fn read(
        &self,
        _: String,
    ) -> BoxFuture<'_, Result<Option<storage::Record>, storage::StoreError>> {
        unreachable!()
    }
    fn batch(
        &self,
        _: Vec<storage::Mutation>,
    ) -> BoxFuture<'_, Result<Vec<storage::Record>, storage::StoreError>> {
        unreachable!()
    }
}
struct Vault {
    record: Mutex<credentials::Record>,
    writes: AtomicUsize,
    race: AtomicBool,
    unknown: AtomicBool,
}
impl credentials::Credentials for Vault {
    fn read(
        &self,
        _: String,
    ) -> BoxFuture<'_, Result<Option<credentials::Record>, storage::StoreError>> {
        Box::pin(async move {
            let record = self.record.lock().unwrap();
            Ok(Some(credentials::Record {
                revision: record.revision,
                secret: record.secret.clone(),
            }))
        })
    }
    fn write(
        &self,
        input: credentials::Write,
    ) -> BoxFuture<'_, Result<credentials::WriteResult, storage::StoreError>> {
        Box::pin(async move {
            self.writes.fetch_add(1, Ordering::SeqCst);
            let mut record = self.record.lock().unwrap();
            if self.race.swap(false, Ordering::SeqCst) {
                record.revision += 1;
            }
            if input.expected_revision != Some(record.revision) {
                return Ok(credentials::WriteResult::Conflict {
                    actual: Some(record.revision),
                });
            }
            record.revision += 1;
            record.secret = input.secret;
            if self.unknown.load(Ordering::SeqCst) {
                return Err(storage::StoreError::OutcomeUnknown("lost receipt".into()));
            }
            Ok(credentials::WriteResult::Written {
                revision: record.revision,
            })
        })
    }
}
#[tokio::test]
async fn credential_patch_checks_read_revision_and_atomic_write_without_losing_unknown() {
    let secret = serde_json::to_string(&Secrets {
        api_key: Some("old".into()),
        headers: [("X-Gateway".into(), "kept".into())].into(),
    })
    .unwrap();
    let vault = Arc::new(Vault {
        record: Mutex::new(credentials::Record {
            revision: 4,
            secret: Some(secret.clone()),
        }),
        writes: AtomicUsize::new(0),
        race: AtomicBool::new(false),
        unknown: AtomicBool::new(false),
    });
    let repository = Repository {
        store: Arc::new(NoSettings),
        credentials: vault.clone(),
    };
    let patch = SecretsPatch {
        api_key: SecretChange::Replace {
            value: "new".into(),
        },
        headers: vec![],
    };
    assert_eq!(
        repository
            .patch_credentials(Settings::default().url, Some(3), patch.clone())
            .await
            .unwrap(),
        credentials::WriteResult::Conflict { actual: Some(4) }
    );
    assert_eq!(vault.writes.load(Ordering::SeqCst), 0);
    vault.race.store(true, Ordering::SeqCst);
    assert_eq!(
        repository
            .patch_credentials(Settings::default().url, Some(4), patch.clone())
            .await
            .unwrap(),
        credentials::WriteResult::Conflict { actual: Some(5) }
    );
    assert_eq!(vault.record.lock().unwrap().secret.as_ref(), Some(&secret));
    vault.unknown.store(true, Ordering::SeqCst);
    assert!(matches!(
        repository
            .patch_credentials(Settings::default().url, Some(5), patch)
            .await,
        Err(storage::StoreError::OutcomeUnknown(_))
    ));
    let stored: Secrets =
        serde_json::from_str(vault.record.lock().unwrap().secret.as_ref().unwrap()).unwrap();
    assert_eq!(stored.api_key.as_deref(), Some("new"));
    assert_eq!(stored.headers["X-Gateway"], "kept");
    assert_eq!(vault.writes.load(Ordering::SeqCst), 2);
}

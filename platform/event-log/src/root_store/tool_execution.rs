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

use super::{RootStore, SessionStore};
use crate::StoreError;
use maka_plugin_core::work::WorkCustody;
use std::sync::Arc;

// Only this module can mint a token containing the selected live SessionStore.
struct SelectedSessionWork(SessionStore);
impl WorkCustody for SelectedSessionWork {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}
impl SessionStore {
    pub fn work_custody(&self) -> Result<Arc<dyn WorkCustody>, StoreError> {
        self.owner()?;
        self.work_lifetime()?;
        Ok(Arc::new(SelectedSessionWork(self.clone())))
    }

    pub(super) fn require_work_custody(&self, custody: &dyn WorkCustody) -> Result<(), StoreError> {
        let selected = selected(custody)?;
        selected.check_session(self.id())?;
        selected.owner()?;
        if !Arc::ptr_eq(&self.work_lifetime()?, &selected.work_lifetime()?) {
            return Err(StoreError::InvalidTransition(
                "scope belongs to another accepted work owner".into(),
            ));
        }
        Ok(())
    }
}
fn selected(custody: &dyn WorkCustody) -> Result<&SessionStore, StoreError> {
    custody
        .as_any()
        .downcast_ref::<SelectedSessionWork>()
        .map(|token| &token.0)
        .ok_or_else(|| StoreError::InvalidTransition("foreign work custody".into()))
}
impl RootStore {
    pub fn fork_effect(
        &self,
        custody: &dyn WorkCustody,
        session_id: &str,
    ) -> Result<super::WorkEffectLease, StoreError> {
        self.session_for_work(custody, session_id)?.fork_effect()
    }

    pub fn fork_work(
        &self,
        custody: &dyn WorkCustody,
        session_id: &str,
    ) -> Result<super::SessionWorkLease, StoreError> {
        self.session_for_work(custody, session_id)?.fork_work()
    }

    /// Use the original selected store and guards. Another opening of the exact
    /// same live RootOwner may inspect this token, but never replaces its gates.
    pub fn session_for_work(
        &self,
        custody: &dyn WorkCustody,
        session_id: &str,
    ) -> Result<SessionStore, StoreError> {
        let store = selected(custody)?;
        store.check_session(session_id)?;
        let owner = store.owner()?;
        store.work_lifetime()?;
        if !Arc::ptr_eq(&self.log.owned_root()?, &owner.owned_root()?) {
            return Err(StoreError::InvalidTransition(
                "foreign Root work custody".into(),
            ));
        }
        Ok(store.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::root::{RootNamespaces, RootOwner};
    use futures_util::poll;
    use maka_plugin_core::work::WorkCustody;
    use maka_sandbox::workspace::{BindingStamp, PermissionBasis};
    use serde_json::{Value, json};
    use std::time::Duration;
    use tokio_util::sync::CancellationToken;

    #[tokio::test]
    async fn original_work_custody_carries_binding_pin_past_queued_writer_and_rejects_foreign_or_finished_tokens()
     {
        let directory = tempfile::tempdir().unwrap();
        let root = RootStore::open(
            Arc::new(
                RootOwner::create(
                    &directory.path().join("root"),
                    &RootNamespaces {
                        ownership: directory.path().join("owners"),
                        control: directory.path().join("control"),
                    },
                )
                .unwrap(),
            ),
            crate::ROOT_MIGRATIONS,
        )
        .await
        .unwrap();
        let reference = root
            .attach_workspace("owner", &json!({"path":"/tmp/tool-custody"}))
            .await
            .unwrap();
        let session = root
            .create_session(
                "session",
                "session",
                &json!({"workspace":reference,"boundary_revision":0}),
                1,
            )
            .await
            .unwrap();
        assert!(session.work_custody().is_err());
        let scope = session
            .work_scope(Some(PermissionBasis {
                binding: BindingStamp {
                    id: reference.id,
                    permission_epoch: 0,
                },
                boundary_revision: 0,
            }))
            .await
            .unwrap();
        let (lease, _effects) = scope.accept(CancellationToken::new());
        let custody = lease.store().work_custody().unwrap();
        let mut writer = Box::pin(
            root.gates
                .write([super::super::gates::Key::Binding(reference.id)]),
        );
        assert!(poll!(&mut writer).is_pending());
        let recovered = root.session_for_work(custody.as_ref(), "session").unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), recovered.get::<Value>())
                .await
                .unwrap()
                .unwrap()
                .unwrap()
                .id,
            "session"
        );
        assert!(root.session_for_work(custody.as_ref(), "foreign").is_err());
        struct Forged;
        impl WorkCustody for Forged {
            fn as_any(&self) -> &dyn std::any::Any {
                self
            }
        }
        assert!(root.session_for_work(&Forged, "session").is_err());
        let other_directory = tempfile::tempdir().unwrap();
        let other = RootStore::open(
            Arc::new(
                RootOwner::create(
                    &other_directory.path().join("root"),
                    &RootNamespaces {
                        ownership: other_directory.path().join("owners"),
                        control: other_directory.path().join("control"),
                    },
                )
                .unwrap(),
            ),
            crate::ROOT_MIGRATIONS,
        )
        .await
        .unwrap();
        assert!(other.session_for_work(custody.as_ref(), "session").is_err());
        other.close().await.unwrap();
        let child = root.fork_work(custody.as_ref(), "session").unwrap();
        let child_store = child.store();
        lease.finish();
        assert!(root.session_for_work(custody.as_ref(), "session").is_err());
        assert!(recovered.get::<Value>().await.is_err());
        assert!(poll!(&mut writer).is_pending());
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), child_store.get::<Value>())
                .await
                .unwrap()
                .unwrap()
                .unwrap()
                .id,
            "session"
        );
        let child_token = child_store.work_custody().unwrap();
        assert!(
            root.session_for_work(child_token.as_ref(), "session")
                .is_ok()
        );
        child.finish();
        assert!(
            root.session_for_work(child_token.as_ref(), "session")
                .is_err()
        );
        drop(
            tokio::time::timeout(Duration::from_secs(2), writer)
                .await
                .unwrap()
                .unwrap(),
        );
        root.close().await.unwrap();
    }
}

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

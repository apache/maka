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

/// Exclusion of physical Session work, not a cleanup receipt or execution grant.
/// Keep this owner through the complete level observation and its caller's CAS.
pub struct SessionWorkFence {
    gates: Arc<gates::Gates>,
    _custody: Arc<EventLog>,
}

impl SessionWorkFence {
    pub(super) fn require_root(&self, root: &RootStore) -> Result<(), StoreError> {
        if !Arc::ptr_eq(&self.gates, &root.gates) {
            return Err(StoreError::InvalidTransition(
                "foreign Root Session work fence".into(),
            ));
        }
        Ok(())
    }
}

impl RootStore {
    pub async fn try_session_work_fence(
        &self,
        id: &str,
    ) -> Result<Option<SessionWorkFence>, StoreError> {
        self.require_open()?;
        crate::sessions::validate_id(id)?;
        let access = self
            .gates
            .read([gates::Key::Session(id.to_owned())])
            .await?;
        let observed = self.log.scoped(Arc::new(access));
        let selected = id.to_owned();
        observed
            .connection
            .read(move |connection| {
                if !super::catalog::session_visible(connection, &selected)? {
                    return Err(StoreError::SessionNotFound);
                }
                Ok(())
            })
            .await?;
        self.require_open()?;
        let work = self.gates.try_write([gates::Key::Work(id.to_owned())])?;
        self.require_open()?;
        let Some(work) = work else {
            return Ok(None);
        };
        Ok(Some(SessionWorkFence {
            gates: self.gates.clone(),
            _custody: Arc::new(observed.scoped(Arc::new(work))),
        }))
    }
}

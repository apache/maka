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
use crate::sessions::SessionRemovalResult;
use maka_sandbox::workspace::BindingRef;

impl RootStore {
    pub fn owned_root(&self) -> Result<Arc<root::RootOwner>, StoreError> {
        self.require_open()?;
        self.log.owned_root()
    }

    pub async fn attach_workspace<T: Serialize>(
        &self,
        scope: &str,
        workspace: &T,
    ) -> Result<BindingRef, StoreError> {
        self.require_open()?;
        let mutation = self.project_mutations.clone().lock_owned().await;
        self.require_open()?;
        self.log
            .scoped(Arc::new(mutation))
            .attach_workspace(scope, workspace)
            .await
    }
    pub async fn workspace_binding<T: DeserializeOwned + Send + 'static>(
        &self,
        id: uuid::Uuid,
    ) -> Result<Option<crate::workspace_bindings::WorkspaceBinding<T>>, StoreError> {
        self.require_open()?;
        self.log.workspace_binding(id).await
    }
    pub async fn begin_session_removal(
        &self,
        session: &str,
        expected: u64,
    ) -> Result<SessionRemovalResult, StoreError> {
        let selected = self.session(session).await?;
        let owner = selected.owner()?;
        let access = self
            .gates
            .write([gates::Key::Session(session.to_owned())])
            .await?;
        let record = owner.get_session::<serde_json::Value>(session).await?;
        let reference = record
            .as_ref()
            .map(|record| crate::workspace_bindings::attached(&record.configuration))
            .transpose()?
            .flatten();
        let binding = self
            .gates
            .read(
                reference
                    .iter()
                    .map(|reference| gates::Key::Binding(reference.id)),
            )
            .await?;
        owner
            .scoped(Arc::new((access, binding)))
            .begin_session_removal(session, expected)
            .await
    }
    pub async fn session_retirement_ready(&self, session: &str) -> Result<bool, StoreError> {
        let selected = self.session(session).await?;
        let access = self
            .gates
            .write([gates::Key::Session(session.to_owned())])
            .await?;
        let Some(work) = self
            .gates
            .try_write([gates::Key::Work(session.to_owned())])?
        else {
            return Ok(false);
        };
        selected
            .owner()?
            // Work must be released before another Session owner is admitted.
            .scoped(Arc::new((work, access)))
            .session_retirement_ready(session)
            .await
    }
}

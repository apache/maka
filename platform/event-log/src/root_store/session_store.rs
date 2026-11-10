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

//! Session-scoped native resources retain the original work and SQL guards.
use super::SessionStore;
use crate::{StoreError, shell_runs::ShellResourcePage};
use maka_plugin_core::shell_run::{ShellPatch, ShellRun};
impl SessionStore {
    pub async fn has_unsettled_shells(&self, session: &str) -> Result<bool, StoreError> {
        self.check_session(session)?;
        self.scoped().await?.has_unsettled_shells(session).await
    }
    pub async fn create_shell_run(&self, record: ShellRun) -> Result<ShellRun, StoreError> {
        self.check_session(&record.session_id)?;
        self.scoped().await?.create_shell_run(record).await
    }
    pub async fn patch_shell_run(
        &self,
        session: &str,
        id: &str,
        patch: ShellPatch,
    ) -> Result<ShellRun, StoreError> {
        self.check_session(session)?;
        self.scoped()
            .await?
            .patch_shell_run(session, id, patch)
            .await
    }
    pub async fn read_shell_run(
        &self,
        session: &str,
        id: &str,
    ) -> Result<Option<ShellRun>, StoreError> {
        self.check_session(session)?;
        self.scoped().await?.read_shell_run(session, id).await
    }
    pub async fn query_shell_resources(
        &self,
        session: &str,
        id: Option<&str>,
        offset: u64,
    ) -> Result<ShellResourcePage, StoreError> {
        self.check_session(session)?;
        self.scoped()
            .await?
            .query_shell_resources(session, id, offset)
            .await
    }
    pub async fn query_shell_catalog(
        &self,
        session: &str,
        provider_prefix: &str,
        offset: u64,
    ) -> Result<ShellResourcePage, StoreError> {
        self.check_session(session)?;
        self.scoped()
            .await?
            .query_shell_catalog(session, provider_prefix, offset)
            .await
    }
    pub async fn change_session_archived<T: serde::de::DeserializeOwned + Send + 'static>(
        &self,
        session: &str,
        expected: Option<u64>,
        archived: bool,
        now: u64,
    ) -> Result<crate::sessions::SessionMutation<T>, StoreError> {
        self.check_session(session)?;
        self.exclusive_metadata(true)
            .await?
            .change_session_archived(session, expected, archived, now)
            .await
    }
    pub async fn admit_session_process(
        &self,
        session: &str,
        id: uuid::Uuid,
    ) -> Result<(), StoreError> {
        self.check_session(session)?;
        self.scoped()
            .await?
            .admit_session_process(session, id)
            .await
    }
    pub async fn clean_session_process(&self, id: uuid::Uuid) -> Result<(), StoreError> {
        self.scoped().await?.clean_session_process(id).await
    }
}

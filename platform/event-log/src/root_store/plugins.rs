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

//! Package storage follows a stable data writer; Session-scoped data shares its family.
use super::*;
use crate::{
    plugins::storage::WritePluginData,
    writeback::{Prepared, Statement},
};
use maka_plugin_core::scope::Scope;
use maka_plugin_core::storage::{Mutation, Namespace, Page, Record, Scan};

impl RootStore {
    async fn plugin_storage(&self, namespace: &Namespace) -> Result<EventLog, StoreError> {
        self.require_open()?;
        if let Scope::Session(session) = namespace.scope() {
            return self.session(session).await?.scoped().await;
        }
        Ok(self.log.scoped(self.log.clone()))
    }
    pub async fn plugin_data_scan(
        &self,
        namespace: &Namespace,
        query: Scan,
    ) -> Result<Page, StoreError> {
        self.plugin_storage(namespace)
            .await?
            .plugin_data_scan(namespace, query)
            .await
    }
    /// Keyset pages of present values, excluding deletion tombstones.
    pub async fn plugin_data_live_scan(
        &self,
        namespace: &Namespace,
        query: Scan,
    ) -> Result<Page, StoreError> {
        self.plugin_storage(namespace)
            .await?
            .plugin_data_live_scan(namespace, query)
            .await
    }
    pub async fn plugin_data(
        &self,
        namespace: &Namespace,
        key: &str,
    ) -> Result<Option<Record>, StoreError> {
        self.plugin_storage(namespace)
            .await?
            .plugin_data(namespace, key)
            .await
    }
    pub async fn plugin_data_batch(
        &self,
        namespace: &Namespace,
        mutations: Vec<Mutation>,
    ) -> Result<Vec<Record>, StoreError> {
        self.plugin_storage(namespace)
            .await?
            .plugin_data_batch(namespace, mutations)
            .await
    }
    /// Move the original physical-work fence into this CAS job's custody.
    /// Observer cancellation does not release it before actual SQL settlement.
    pub async fn plugin_data_batch_with_work_fence(
        &self,
        namespace: &Namespace,
        mutations: Vec<Mutation>,
        fence: SessionWorkFence,
    ) -> Result<Vec<Record>, StoreError> {
        fence.require_root(self)?;
        self.plugin_storage(namespace)
            .await?
            .scoped(Arc::new(fence))
            .plugin_data_batch(namespace, mutations)
            .await
    }

    /// Prepare a namespace-scoped CAS batch for the original Host completion.
    /// The returned records describe the guarded result, not a committed write.
    pub fn prepare_plugin_data_batch(
        &self,
        namespace: &Namespace,
        mutations: Vec<Mutation>,
        writer: &DataWriter,
    ) -> Result<(Vec<Record>, DataChange), StoreError> {
        let owner = self.log.owned_root()?;
        if !writer.matches_owner(&owner) {
            return Err(StoreError::InvalidTransition(
                "foreign Root data writer".into(),
            ));
        }
        let (records, statement) =
            crate::plugins::storage::WritePluginData::for_completion(namespace, mutations)?;
        Ok((records, writer.prepare(statement)))
    }

    /// A pure CAS statement bound to this writer's original physical custody.
    pub fn prepare_plugin_data_statement(
        &self,
        namespace: &Namespace,
        mutations: Vec<Mutation>,
        writer: &DataWriter,
    ) -> Result<impl Statement<Value = Vec<Record>, Output = Vec<Record>> + Clone + use<>, StoreError>
    {
        self.validate_data_writer(writer)?;
        let custody = Arc::new(writer.scoped()?);
        if let Scope::Session(session) = namespace.scope() {
            if custody.expected_session.is_none() {
                return Err(StoreError::InvalidTransition(
                    "Session plugin data requires a Session-bound writer".into(),
                ));
            }
            custody.check_bound_session(session)?;
        }
        let (_, statement) = WritePluginData::for_completion(namespace, mutations)?;
        Ok(PluginDataStatement { statement, custody })
    }

    pub async fn commit_operation_data(
        &self,
        claim: &crate::applications::operations::DispatchClaim,
        namespace: &Namespace,
        mutations: Vec<Mutation>,
        result: maka_plugin_core::operation::OperationResult,
    ) -> Result<maka_plugin_core::operation::OperationObservation, StoreError> {
        // This is final settlement of an existing claim, not a new admission.
        // Session publication is checked in the same write transaction.
        self.log
            .scoped(self.log.clone())
            .commit_operation_data(claim, namespace, mutations, result)
            .await
    }
}

#[derive(Clone)]
struct PluginDataStatement {
    statement: WritePluginData,
    custody: Arc<EventLog>,
}
impl Statement for PluginDataStatement {
    type Value = Vec<Record>;
    type Output = Vec<Record>;
    const PREPARE_OFF_THREAD: bool = WritePluginData::PREPARE_OFF_THREAD;
    fn retain(&self) -> Vec<Arc<dyn Send + Sync>> {
        let mut retained = self.statement.retain();
        retained.push(self.custody.clone());
        retained
    }
    fn prepare(mut self) -> Result<Self, StoreError> {
        self.statement = self.statement.prepare()?;
        Ok(self)
    }
    fn execute(self, connection: &SqliteConnection) -> Result<Prepared<Self::Value>, StoreError> {
        self.custody.connection.require_same_writer(connection)?;
        self.custody.owned_root()?;
        self.statement.execute(connection)
    }
    fn committed(value: Self::Value) -> Self::Output {
        WritePluginData::committed(value)
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        WritePluginData::isolated_rejection(error)
    }
}

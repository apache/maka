/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
use super::super::*;
use crate::{
    sessions::metadata::MetadataChange,
    writeback::{Notification, Prepared, Statement},
};

impl RootStore {
    pub async fn prepare_session_metadata<T, F, S>(
        &self,
        id: &str,
        expected: u64,
        update: F,
        writer: &DataWriter,
        statement: S,
    ) -> Result<(SessionRecord<T>, DataChange), StoreError>
    where
        T: Serialize + DeserializeOwned + Clone + PartialEq + Send + 'static,
        F: FnOnce(&mut T) -> Result<(), StoreError> + Send + 'static,
        S: Statement,
    {
        if !self.data_writer()?.same_root(writer) {
            return Err(StoreError::InvalidTransition(
                "foreign Root data writer".into(),
            ));
        }
        let selected = self.session(id).await?;
        let (custody, change) = selected.metadata_change(id, expected, update).await?;
        let record = change.record.clone();
        let mutation = writer.prepare(SessionMetadataChange {
            change,
            statement,
            custody: Arc::new(custody),
        });
        Ok((record, mutation))
    }
}
struct SessionMetadataChange<T, S> {
    change: MetadataChange<T>,
    statement: S,
    custody: Arc<EventLog>,
}
impl<T: Send + 'static, S: Statement> Statement for SessionMetadataChange<T, S> {
    type Value = S::Value;
    type Output = S::Output;
    const PREPARE_OFF_THREAD: bool = S::PREPARE_OFF_THREAD;
    fn retain(&self) -> Vec<Arc<dyn Send + Sync>> {
        let mut inputs = self.statement.retain();
        inputs.push(self.custody.clone());
        inputs
    }
    fn prepare(mut self) -> Result<Self, StoreError> {
        self.statement = self.statement.prepare()?;
        Ok(self)
    }
    fn execute(self, connection: &SqliteConnection) -> Result<Prepared<Self::Value>, StoreError> {
        self.change.validate(connection)?;
        let (record, changed) = self.change.apply(connection)?;
        let domain = self.statement.execute(connection)?;
        let root = if changed {
            Notification::METADATA.with_sessions([record.id])
        } else {
            Notification::NONE
        };
        Ok(Prepared {
            value: domain.value,
            changed: changed || domain.changed,
            notification: domain.notification.combine(root),
        })
    }
    fn committed(value: Self::Value) -> Self::Output {
        S::committed(value)
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        S::isolated_rejection(error)
            || matches!(
                error,
                StoreError::SessionNotFound
                    | StoreError::SessionRetired
                    | StoreError::SessionBusy
                    | StoreError::SessionRevisionConflict { .. }
                    | StoreError::InvalidTransition(_)
            )
    }
}

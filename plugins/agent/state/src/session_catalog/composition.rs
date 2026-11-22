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
use std::sync::Arc;

/// The original domain input and catalog command share one Root statement.
/// This object does not apply a control or publish a planned Session.
pub struct ControlledStatement<S> {
    statement: S,
    control: ControlStatement,
}
impl ControlStatement {
    pub fn command(&self) -> &ControlCommand {
        &self.2
    }
    pub fn session(&self) -> &str {
        &self.1
    }
    pub fn owner(&self) -> &RunOwner {
        &self.0.owner
    }
    pub fn data_writer(&self) -> &DataWriter {
        &self.0.data
    }

    pub fn with<S: Statement>(
        self,
        statement: S,
        writer: &DataWriter,
    ) -> Result<ControlledStatement<S>, StoreError> {
        if !self.0.data.same_root(writer) {
            return Err(invalid("catalog control belongs to another Root writer"));
        }
        Ok(ControlledStatement {
            statement,
            control: self,
        })
    }
}
impl<S: Statement> Statement for ControlledStatement<S> {
    type Value = S::Value;
    type Output = S::Output;
    const PREPARE_OFF_THREAD: bool = S::PREPARE_OFF_THREAD;

    fn retain(&self) -> Vec<Arc<dyn Send + Sync>> {
        let mut owners = self.statement.retain();
        owners.extend(self.control.retain());
        owners
    }
    fn prepare(self) -> Result<Self, StoreError> {
        Ok(Self {
            statement: self.statement.prepare()?,
            control: self.control.prepare()?,
        })
    }
    fn execute(self, c: &Connection) -> Result<Prepared<Self::Value>, StoreError> {
        let original = self.statement.execute(c)?;
        let control = self.control.execute(c)?;
        Ok(Prepared {
            value: original.value,
            changed: original.changed || control.changed,
            notification: original.notification.combine(control.notification),
        })
    }
    fn committed(value: Self::Value) -> Self::Output {
        S::committed(value)
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        S::isolated_rejection(error) || ControlStatement::isolated_rejection(error)
    }
}

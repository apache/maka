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

//! Pure native domain statements sealed by the actual dispatched callback.
use super::{Context, HandlerValue, Result};
use crate::storage::StateChange;
use maka_event_log::{
    root_store::{DataChange, DataWriter},
    writeback::Statement,
};
use serde_json::Value;

impl Context {
    /// Describe final domain state without running SQL or admitting a new effect.
    /// The Host checks the original operation and actual Root again at commit.
    pub fn prepare_statement<S: Statement>(
        &self,
        writer: &DataWriter,
        statement: S,
    ) -> Result<StateChange> {
        self.prepare_change(writer.prepare(statement))
    }

    /// Seal an already prepared native domain change with this actual callback.
    /// The deferred statement is not a wire value or a new execution admission.
    pub fn complete_change(&self, value: Value, change: DataChange) -> Result<HandlerValue> {
        Ok(HandlerValue::Commit {
            value,
            state: self.prepare_change(change)?,
        })
    }

    /// The original Host validates this statement's actual output inside SQL,
    /// then records it with its domain changes in the same Root transaction.
    pub fn complete_result(&self, change: DataChange) -> Result<HandlerValue> {
        Ok(HandlerValue::Computed {
            state: self.prepare_change(change)?,
        })
    }

    fn prepare_change(&self, change: DataChange) -> Result<StateChange> {
        if self.scope().cancellation.is_cancelled() {
            return Err("state completion callback is cancelled".into());
        }
        let operation = self
            .operation_scope()
            .ok_or("pure state completion requires a durable mutation")?
            .clone();
        Ok(StateChange::statement(change, operation))
    }
}

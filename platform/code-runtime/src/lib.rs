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

//! Shared cell outputs, JSON state and Host effect ownership for code interpreters.

mod cell_context;
mod result;
mod scope;
mod timeout;

pub use cell_context::{CellContext, CellOutput, CellStore, NotificationGate, ToolMetadata};
pub use result::{CellAbort, CellDiagnostic, CellDiagnosticKind, CellResult, ToolCall, complete};
pub use scope::ToolScope;
use std::time::Duration;
pub use timeout::{CellTimeoutBudget, CellTimeoutGuard};

#[derive(Clone, Debug)]
pub struct CellLimits {
    /// Cumulative synchronous VM execution, excluding asynchronous Host tool waits.
    pub timeout: Duration,
    /// Interpreter allocation budget; each backend documents its accounting boundary.
    pub heap_bytes: usize,
}

impl Default for CellLimits {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(30),
            heap_bytes: 64 * 1024 * 1024,
        }
    }
}

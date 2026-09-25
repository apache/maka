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

mod authorization;
mod client;
pub use authorization::*;
mod input;
mod output;
mod projection;
mod remote;
pub use client::*;
pub use input::*;
pub use output::*;
pub use projection::*;
pub use remote::*;

use crate::{Operation, OperationErrorCode};

pub const ERRORS: &[OperationErrorCode] = &[
    OperationErrorCode::HostNotReady,
    OperationErrorCode::HostDraining,
    OperationErrorCode::InvalidRequest,
    OperationErrorCode::OperationUnavailable,
    OperationErrorCode::OperationConflict,
    OperationErrorCode::NotFound,
    OperationErrorCode::StaleCursor,
    OperationErrorCode::SourceUnreadable,
    OperationErrorCode::PersistenceFailed,
    OperationErrorCode::CommitOutcomeUnknown,
    OperationErrorCode::OutcomeUnknown,
    OperationErrorCode::InternalFailure,
    OperationErrorCode::Unauthorized,
];

pub fn supports(operation: Operation) -> bool {
    matches!(
        operation,
        Operation::PluginClientQuery
            | Operation::PluginAuthorization
            | Operation::PluginRemote
            | Operation::PluginPlatformQuery
            | Operation::PluginPlatformReconcile
            | Operation::PluginCompositionApply
            | Operation::PluginPackageInstall
            | Operation::PluginPackagePreview
            | Operation::PluginPackageUninstall
            | Operation::PluginPackageReload
            | Operation::PluginPackageExport
    )
}

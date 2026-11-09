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

//! One original native publication item, never a Tool or a serialized grant.
use futures_util::future::BoxFuture;
use maka_agent_api::session::ResolvedConfiguration;
use maka_agent_facts::{
    durable::{ExecutionIdentity, ExternalPublicationId, ExternalTaskId},
    tools::ToolError,
};
use maka_fs_tools::publication::{PublicationChange, SourceIdentity};
use maka_host_runtime::application::Context;
use maka_plugin_core::operation::RecoveryRef;
use maka_sandbox::workspace::PermissionBasis;
use std::sync::Arc;

pub struct PublicationCallContext(pub Arc<dyn PublicationAccess>);

pub trait PublicationAccess: Send + Sync {
    fn execution(&self) -> &ExecutionIdentity;
    fn task(&self) -> ExternalTaskId;
    fn publication(&self) -> ExternalPublicationId;
    fn index(&self) -> u64;
    fn permission_basis(&self) -> &PermissionBasis;
    fn change(&self) -> &PublicationChange;
    fn source(&self) -> &SourceIdentity;

    /// Check this actual role, original custody, current claim/item/basis and
    /// fixed content resource. Return the original selected SOURCE workspace's
    /// live configuration, never the executor's private writable directory.
    fn validate<'a>(
        &'a self,
        context: &'a Context,
    ) -> BoxFuture<'a, Result<ResolvedConfiguration, ToolError>>;

    /// Bind the exact admitted Host CallerIntent/reference to this item before
    /// mutation. A selector or saved descriptor cannot create this authority.
    fn bind_original<'a>(
        &'a self,
        context: &'a Context,
    ) -> BoxFuture<'a, Result<RecoveryRef, ToolError>>;
}

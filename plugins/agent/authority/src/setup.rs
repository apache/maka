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

//! One actual top-level setup source, independent of Agent or Session execution.
use futures_util::future::BoxFuture;
pub use maka_agent_ports::remote::Error;
use maka_host_runtime::application::Context;
use maka_plugin_core::operation::RecoveryRef;
use std::sync::Arc;

pub struct ActualSetupContext(pub Arc<dyn SetupAccess>);

pub trait SetupAccess: Send + Sync {
    /// Check the original operation, resources, captured activation and caller
    /// policy. This does not grant a process or credential-profile capability.
    fn validate<'a>(&'a self, context: &'a Context) -> BoxFuture<'a, Result<(), Error>>;

    /// Prepare for this exact selected command after the provider-bound readonly
    /// profile seed and current caller floor have been applied. Command data alone
    /// grants no access; the returned owner must preserve this launch selection.
    fn prepare_private_process<'a>(
        &'a self,
        context: &'a Context,
        selected: &'a maka_process::Command,
    ) -> BoxFuture<'a, Result<maka_process::isolated::TaskOwner, Error>>;

    /// Retain a frozen HOME belonging to this source's original preparation.
    /// This stages material only; it does not publish the profile selector.
    fn stage_home<'a>(
        &'a self,
        context: &'a Context,
        home: maka_process::isolated::FrozenHome,
    ) -> BoxFuture<'a, Result<(), Error>>;

    /// Only the original top-level handler may prepare its selector change,
    /// committed together with that operation's successful Returned receipt.
    fn prepare_profile<'a>(
        &'a self,
        context: &'a Context,
    ) -> BoxFuture<'a, Result<Option<maka_host_runtime::storage::StateChange>, Error>>;

    /// Bind this exact Host setup invocation to the original admitted source;
    /// serialized references and Remote identities cannot create this source.
    fn bind_original<'a>(
        &'a self,
        context: &'a Context,
    ) -> BoxFuture<'a, Result<RecoveryRef, Error>>;
}

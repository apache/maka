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

//! A call-bound native Computer capability. Serializable identities and observations do not mint it.
use crate::permissions::Access;
use futures_util::future::BoxFuture;
use maka_agent_api::session::ResolvedConfiguration;
use maka_agent_facts::language::Language;
use maka_agent_facts::{
    artifact::Artifact,
    interaction::*,
    tools::{ToolCallContext, ToolError},
};
use maka_event_log::root_store::DataChange;
use maka_host_runtime::application::Context;
use maka_plugin_core::operation::RecoveryRef;
use std::sync::Arc;

/// Exactly one actual caller capsule crosses the local Host boundary.
pub enum NativeCallContext {
    Agent(Arc<dyn NativeCallAccess>),
    Computer(Arc<dyn ComputerAccess>),
}
impl NativeCallContext {
    pub fn access(&self) -> &dyn NativeCallAccess {
        match self {
            Self::Agent(access) => access.as_ref(),
            Self::Computer(access) => access.as_ref(),
        }
    }
    pub fn computer(&self) -> Option<Arc<dyn ComputerAccess>> {
        match self {
            Self::Computer(access) => Some(access.clone()),
            Self::Agent(_) => None,
        }
    }
}

/// The native adapter supplies real discovery and protocol evidence, never an app path from JSON.
#[derive(Clone)]
pub struct ComputerAppObservation {
    pub native_operation_id: String,
    pub target: GrantTarget,
    pub display: ComputerAppDisplay,
    pub allow_always: bool,
    pub capture: serde_json::Value,
}
#[derive(Clone, Debug)]
pub struct ComputerAppStatus {
    pub stopped: bool,
    pub granted: bool,
    pub authority_revision: u64,
}

pub trait NativeCallAccess: Access {
    fn call(&self) -> &ToolCallContext;
    /// Original data owner observation; live capability and Root checks still apply.
    fn run_owner(&self) -> &maka_agent_facts::durable::RunOwner;
    fn target(&self) -> &maka_agent_facts::durable::AuthorizationObligation;
    fn language(&self) -> Language;
    fn current(&self) -> BoxFuture<'_, Result<ResolvedConfiguration, ToolError>>;
    /// Validate actual Host dispatch, original native caller intent and original custody.
    /// Bind canonical original-reference evidence only; do not fabricate a provider outcome.
    fn bind_original<'a>(
        &'a self,
        context: &'a Context,
    ) -> BoxFuture<'a, Result<RecoveryRef, ToolError>>;
}

/// Callback bound to one real native producer and its captured accepted SQL ingress.
/// It may record that producer's interruption, never admit another input.
pub type NativeInterruptionSink = Arc<
    dyn Fn(maka_computer_use::NativeInterruption) -> BoxFuture<'static, Result<(), ToolError>>
        + Send
        + Sync,
>;

/// Read-only policy for an already owned audio output. It cannot admit input
/// and does not keep the creating Run or its work pins alive.
pub trait SessionAudioRetention: Send + Sync {
    fn current(&self) -> BoxFuture<'_, Result<bool, ToolError>>;
}

/// Retained read authority for one actual Run. No input, consent publication,
/// original-call capsule or work lease can be obtained from this interface.
pub trait ComputerPreviewAccess: Send + Sync {
    fn execution(&self) -> &maka_agent_facts::durable::ExecutionIdentity;
    fn current(&self) -> BoxFuture<'_, Result<ResolvedConfiguration, ToolError>>;
    fn granted<'a>(&'a self, target: &'a GrantTarget) -> BoxFuture<'a, Result<(), ToolError>>;
    fn native_current(&self) -> BoxFuture<'_, Result<(), ToolError>>;
    /// Read-only status of an observed app in this exact execution and current
    /// permission basis, independent of the observing call's input obligation.
    /// This cannot request consent or authorize native input.
    fn app_status<'a>(
        &'a self,
        operation: &'a str,
        target: &'a maka_computer_use::ComputerAppTarget,
    ) -> BoxFuture<'a, Result<ComputerAppStatus, ToolError>>;
}

pub trait ComputerAccess: NativeCallAccess {
    /// Observe the creating Run's lifetime, never its settled input obligation.
    fn run_current(&self) -> BoxFuture<'_, Result<(), ToolError>>;
    fn retain_preview<'a>(
        &'a self,
        basis: &'a maka_sandbox::workspace::PermissionBasis,
    ) -> BoxFuture<'a, Result<Arc<dyn ComputerPreviewAccess>, ToolError>>;
    fn session_audio_retention<'a>(
        &'a self,
        basis: &'a maka_sandbox::workspace::PermissionBasis,
    ) -> BoxFuture<'a, Result<Arc<dyn SessionAudioRetention>, ToolError>>;
    /// Bind the sealed native producer while its original Host call is admitted.
    fn native_bound<'a>(
        &'a self,
        original: &'a RecoveryRef,
        source: maka_computer_use::NativeBindingSource,
        source_writer: maka_event_log::root_store::DataWriter,
    ) -> BoxFuture<'a, Result<NativeInterruptionSink, ToolError>>;
    /// Native-input only. Browser admission must not consult this turn fence.
    fn native_admission(&self) -> BoxFuture<'_, Result<(), ToolError>>;
    fn boundary(
        &self,
    ) -> BoxFuture<'_, Result<maka_plugin_core::authorization::Boundary, ToolError>>;
    fn client_grant<'a>(
        &'a self,
        target: &'a GrantTarget,
    ) -> BoxFuture<'a, Result<Option<SessionGrant>, ToolError>>;
    fn observe_app<'a>(
        &'a self,
        original: &'a RecoveryRef,
        observation: ComputerAppObservation,
    ) -> BoxFuture<'a, Result<ComputerAppStatus, ToolError>>;
    fn app_status<'a>(
        &'a self,
        native_operation: &'a str,
    ) -> BoxFuture<'a, Result<ComputerAppStatus, ToolError>>;
    fn request_app<'a>(
        &'a self,
        native_operation: &'a str,
    ) -> BoxFuture<'a, Result<InteractionRecord, ToolError>>;
    /// True only for a newly committed native-action admission. False observes the original;
    /// it is not permission to dispatch that action again.
    fn authorize_app<'a>(
        &'a self,
        native_operation: &'a str,
    ) -> BoxFuture<'a, Result<bool, ToolError>>;
    /// Real native OS observation; this completes a notification, not an Agent permission grant.
    fn system_permission_observed<'a>(
        &'a self,
        request: &'a str,
        grants: Vec<SystemPermissionGrant>,
    ) -> BoxFuture<'a, Result<InteractionRecord, ToolError>>;
    /// The producer's artifact is committed with its original Host result receipt.
    fn prepare_artifact<'a>(
        &'a self,
        original: &'a RecoveryRef,
        artifact: Artifact,
        bytes: Vec<u8>,
    ) -> BoxFuture<'a, Result<DataChange, ToolError>>;
}

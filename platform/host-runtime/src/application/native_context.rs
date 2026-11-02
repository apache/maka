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

/// Trusted native initialization receives facts from its actual Host owner,
/// after the initialization resource fence has been acquired. There is no guest
/// constructor, serialized capability, or implicit service activation here.
/// Any acquired native work remains the returned NativeOwner's responsibility.
pub struct NativeContext {
    pub(super) activation: Activation,
    pub(super) package: PackageRef,
    pub(super) persistence: Option<NativePersistence>,
    pub(super) services: NativeServices,
}
impl NativeContext {
    /// Exact immutable package selected by the actual deployment plan.
    pub fn package(&self) -> &PackageRef {
        &self.package
    }

    pub fn activation(&self) -> &Activation {
        &self.activation
    }
    /// Captured imports for work owned by this actual native plugin. This is
    /// not a grant; every invocation still passes the embedding's Host policy.
    pub fn services(&self) -> NativeServices {
        self.services.clone()
    }
    /// Ephemeral applications have no persistence. A native service requiring
    /// persistence must reject initialization rather than open a fallback Root.
    pub fn persistence(&self) -> Option<&NativePersistence> {
        self.persistence.as_ref()
    }
}

/// Exact applied source and its actual store travel together. Stable native
/// data ownership uses the Root domain, deployment UUID and instance identity;
/// source revision and activation epoch identify execution, not a new data owner.
/// Cloning the store retains its lease; it does not acknowledge native cleanup.
pub struct NativePersistence {
    pub(super) source: DeploymentRef,
    pub(super) store: Arc<maka_event_log::root_store::RootStore>,
}
impl NativePersistence {
    pub fn source(&self) -> &DeploymentRef {
        &self.source
    }
    pub fn store(&self) -> &Arc<maka_event_log::root_store::RootStore> {
        &self.store
    }
}

/// Frozen imports, own exports and dispatch for the original native activation.
/// Unlike a request Context, this handle does not inherit a peer's cancellation
/// or permission evidence. It cannot redirect retired bindings to a replacement.
#[derive(Clone)]
pub struct NativeServices {
    pub(super) activation: Activation,
    pub(super) imports: Arc<BTreeMap<String, Vec<Binding>>>,
    pub(super) exports: Arc<BTreeMap<String, Binding>>,
    pub(super) dispatch: Weak<Dispatch>,
    pub(super) issuer: Issuer,
    pub(super) preparation_resources:
        maka_capabilities::model_preparation::ModelPreparationResources,
}
/// Private origin evidence can only be created through the Host's native factory
/// context. Public Identity remains observation and is never an authorization.
pub(super) struct NativeOrigin(pub Activation);
impl NativeServices {
    /// Shared Host allocation admission for model capture and streaming uploads.
    pub fn model_preparation_resources(
        &self,
    ) -> maka_capabilities::model_preparation::ModelPreparationResources {
        self.preparation_resources.clone()
    }

    pub fn imports(&self) -> impl Iterator<Item = (&str, &[Binding])> {
        self.imports
            .iter()
            .map(|(name, bindings)| (name.as_str(), bindings.as_slice()))
    }
    /// Select one captured service, including an export published by this owner.
    /// Own exports cannot execute until activation has successfully published them.
    pub fn binding(&self, target: &ServiceTarget) -> Result<&Binding> {
        super::context::select_service(&self.imports, &self.exports, target)
    }
    /// The native owner supplies its domain work's identity and cancellation.
    /// A request is inert until ordinary call/subscribe/mutate/recover admission succeeds.
    pub fn request(
        &self,
        identity: maka_capabilities::call::Identity,
        cancellation: CancellationToken,
    ) -> Result<NativeRequest> {
        self.request_inner(identity, cancellation, None)
    }
    /// Inherit the original Engine custody through actual Host child scopes.
    pub fn request_with_execution(
        &self,
        identity: maka_capabilities::call::Identity,
        cancellation: CancellationToken,
        execution: Arc<dyn maka_agent_facts::tools::ExecutionCustody>,
    ) -> Result<NativeRequest> {
        self.request_inner(identity, cancellation, Some(execution))
    }
    fn request_inner(
        &self,
        identity: maka_capabilities::call::Identity,
        cancellation: CancellationToken,
        execution: Option<Arc<dyn maka_agent_facts::tools::ExecutionCustody>>,
    ) -> Result<NativeRequest> {
        let origin = NativeOrigin(self.activation.clone());
        let scope = match execution {
            Some(execution) => {
                self.issuer
                    .issue_with_execution(identity, origin, cancellation, execution)
            }
            None => self.issuer.issue_with(identity, origin, cancellation),
        }
        .map_err(|error| error.to_string())?;
        Ok(NativeRequest(Context {
            stream: None,
            caller: None,
            scope,
            consumer: self.activation.clone(),
            requester: self.activation.clone(),
            operation: None,
            operation_scope: None,
            attachments: Attachments::default(),
            imports: self.imports.clone(),
            exports: self.exports.clone(),
            dispatch: self.dispatch.clone(),
        }))
    }
}
/// Owned domain request, independent of the service call that started the work.
/// NativeOwner must finish all such requests before confirming its own cleanup.
/// Drop only requests cancellation; it cannot acknowledge executor cleanup.
pub struct NativeRequest(Context);
impl std::ops::Deref for NativeRequest {
    type Target = Context;
    fn deref(&self) -> &Context {
        &self.0
    }
}
impl NativeRequest {
    pub async fn finish(&self) -> Result<()> {
        self.0
            .scope
            .finish()
            .await
            .map_err(|error| error.to_string())
    }
}
impl Drop for NativeRequest {
    fn drop(&mut self) {
        self.0.scope.cancellation.cancel();
    }
}

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
    pub(super) selected_method: Option<Arc<SelectedNativeMethod>>,
    pub(super) preparation_resources:
        maka_capabilities::model_preparation::ModelPreparationResources,
}
/// Private origin evidence can only be created through the Host's native factory
/// context. Public Identity remains observation and is never an authorization.
pub(super) struct NativeOrigin {
    pub activation: Activation,
    pub selected_method: Option<Arc<SelectedNativeMethod>>,
    pub caller_context: Option<Arc<dyn std::any::Any + Send + Sync>>,
    direct_resources:
        std::sync::OnceLock<std::sync::Weak<maka_plugin_core::work::resources::Resources>>,
}
impl NativeOrigin {
    pub(super) fn is_direct(&self, scope: &Scope) -> bool {
        self.direct_resources
            .get()
            .and_then(std::sync::Weak::upgrade)
            .is_some_and(|resources| Arc::ptr_eq(&resources, &scope.resources))
    }
}

/// An in-memory method capability captured by trusted native initialization.
/// It is never serialized or reconstructed from model-provided identifiers.
pub struct SelectedNativeMethod {
    pub(super) binding: Binding,
    pub(super) method: String,
}
impl SelectedNativeMethod {
    pub(super) fn matches(&self, binding: &Binding, method: &str) -> bool {
        self.binding.consumer() == binding.consumer()
            && self.binding.provider() == binding.provider()
            && self.binding.registration_epoch() == binding.registration_epoch()
            && self.binding.export() == binding.export()
            && self.method == method
    }
    pub(super) fn recovers(&self, consumer: &Activation, reference: &RecoveryRef) -> bool {
        self.binding.consumer() == consumer
            && self.binding.provider().instance() == &reference.namespace
            && self.binding.export() == reference.export
            && self.method == reference.method
    }
}
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
    /// Capture the exact method selected by a native tool declaration. Requests
    /// made from this handle authorize only that original binding and method;
    /// auxiliary calls still require the embedding's independent native grants.
    pub fn select_method(&self, target: &ServiceTarget, method: &str) -> Result<Self> {
        self.select_binding_method(self.binding(target)?, method)
    }
    /// Select a member of this activation's actual captured import bindings.
    /// The index selects only from that immutable capture; it is not a grant.
    pub fn select_import_method(
        &self,
        import: &str,
        provider: usize,
        method: &str,
    ) -> Result<Self> {
        let binding = self
            .imports
            .get(import)
            .and_then(|bindings| bindings.get(provider))
            .ok_or("selected native import provider is unavailable")?;
        self.select_binding_method(binding, method)
    }
    fn select_binding_method(&self, binding: &Binding, method: &str) -> Result<Self> {
        let Interface::Service { methods } = &binding.contract().interface else {
            return Err("selected native method requires a service".into());
        };
        if !methods.contains_key(method) {
            return Err("selected native service method is unavailable".into());
        }
        let mut selected = self.clone();
        selected.selected_method = Some(Arc::new(SelectedNativeMethod {
            binding: binding.clone(),
            method: method.into(),
        }));
        Ok(selected)
    }
    /// The native owner supplies its domain work's identity and cancellation.
    /// A request is inert until ordinary call/subscribe/mutate/recover admission succeeds.
    pub fn request(
        &self,
        identity: maka_capabilities::call::Identity,
        cancellation: CancellationToken,
    ) -> Result<NativeRequest> {
        self.request_inner(identity, cancellation, None, None)
    }
    /// Carry actual native context for work without a Session or Run custody.
    pub fn request_with_context<T: std::any::Any + Send + Sync>(
        &self,
        identity: maka_capabilities::call::Identity,
        cancellation: CancellationToken,
        context: Arc<T>,
    ) -> Result<NativeRequest> {
        self.request_inner(identity, cancellation, None, Some(context))
    }

    /// Inherit the original work custody through actual Host child scopes.
    pub fn request_with_work(
        &self,
        identity: maka_capabilities::call::Identity,
        cancellation: CancellationToken,
        custody: Arc<dyn maka_plugin_core::work::WorkCustody>,
    ) -> Result<NativeRequest> {
        self.request_inner(identity, cancellation, Some(custody), None)
    }
    /// Carry one actual native domain context through local Host dispatch.
    /// It is never encoded, recovered from identifiers, or sent to another Host.
    pub fn request_with_work_and_context<T: std::any::Any + Send + Sync>(
        &self,
        identity: maka_capabilities::call::Identity,
        cancellation: CancellationToken,
        custody: Arc<dyn maka_plugin_core::work::WorkCustody>,
        context: Arc<T>,
    ) -> Result<NativeRequest> {
        self.request_inner(identity, cancellation, Some(custody), Some(context))
    }

    fn request_inner(
        &self,
        identity: maka_capabilities::call::Identity,
        cancellation: CancellationToken,
        custody: Option<Arc<dyn maka_plugin_core::work::WorkCustody>>,
        caller_context: Option<Arc<dyn std::any::Any + Send + Sync>>,
    ) -> Result<NativeRequest> {
        let origin = NativeOrigin {
            activation: self.activation.clone(),
            selected_method: self.selected_method.clone(),
            caller_context,
            direct_resources: std::sync::OnceLock::new(),
        };
        let scope = match custody {
            Some(custody) => self
                .issuer
                .issue_with_work(identity, origin, cancellation, custody),
            None => self.issuer.issue_with(identity, origin, cancellation),
        }
        .map_err(|error| error.to_string())?;
        let origin = self
            .issuer
            .evidence::<NativeOrigin>(&scope)
            .expect("just-issued native scope");
        assert!(
            origin
                .direct_resources
                .set(Arc::downgrade(&scope.resources))
                .is_ok()
        );
        Ok(NativeRequest(Context {
            stream: None,
            caller: None,
            native_context: None,
            scope,
            consumer: self.activation.clone(),
            requester: self.activation.clone(),
            operation: None,
            operation_scope: None,
            state: Err("native requests have no captured provider state".into()),
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
    /// Only adds restrictions; the request still needs its original admission.
    pub fn with_sandbox_floor(mut self, floor: &maka_sandbox::Sandbox) -> Result<Self> {
        self.0
            .scope
            .restrict_sandbox(floor)
            .map_err(|error| error.to_string())?;
        Ok(self)
    }

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

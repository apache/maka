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

//! Explicitly composed management of a fixed deployment in the original Root.
use super::*;
use maka_event_log::root_store::RootStore;
use maka_event_log::{StoreError, applications::validate_application};
use maka_plugin_core::contract::binary_resource_type;
use maka_plugin_core::deployment::management::{
    DeploymentDocument, DeploymentDocumentChunk, DeploymentDocumentRead, DeploymentInstances,
    DeploymentRead, DeploymentReplace, InstanceSetEnabled, ManagedInstance, ManagedInstancesPage,
    ManagementRejection, ManagementResult, PackageBundleExport, PackageBundleRead, PackageInstall,
    PackageInstalled, deployment_manager_contract,
};
use serde::Deserialize;

mod authoring;
mod download;
pub use download::download_bundle;
mod composition;
mod settings;
#[cfg(test)]
mod tests;

pub const DEPLOYMENT_MANAGER: &str = "maka.application.management";

/// Trusted launcher handle. The target and execution environment never come
/// from guest configuration or mutation input; every operation uses Host admission.
#[derive(Clone)]
pub struct ManagementTarget(Manager);
impl ManagementTarget {
    pub async fn from_source(store: Arc<RootStore>, source: DeploymentRef) -> Result<Self> {
        let metadata = store
            .read_application_metadata_at(&source)
            .await
            .map_err(|error| error.to_string())?
            .ok_or("managed source not found")?;
        let environment = metadata.source.input.environment;
        environment
            .entry_target()
            .map_err(|error| error.to_string())?;
        Ok(Self(Manager {
            source,
            store,
            environment,
            writes: Arc::new(tokio::sync::Mutex::new(())),
        }))
    }
}

#[derive(Clone)]
struct Manager {
    source: DeploymentRef,
    store: Arc<RootStore>,
    environment: maka_plugin_core::composition::Environment,
    writes: Arc<tokio::sync::Mutex<()>>,
}
impl Manager {
    async fn metadata(
        &self,
    ) -> Result<maka_plugin_core::deployment::management::ManagedDeployment> {
        self.store
            .read_application_metadata(self.source.deployment)
            .await
            .map_err(|error| error.to_string())?
            .ok_or("managed deployment not found".into())
    }
    async fn instances(&self, input: Value) -> Result<Value> {
        let request: DeploymentInstances =
            serde_json::from_value(input).map_err(|e| e.to_string())?;
        let _materialize = self.writes.lock().await;
        let (source, after) = match request {
            DeploymentInstances::Start {} => (self.metadata().await?.source.reference, None),
            DeploymentInstances::Continue { source, after } => (source, after),
        };
        if source.state_domain != self.source.state_domain
            || source.deployment != self.source.deployment
        {
            return Err("foreign managed deployment source".into());
        }
        let loaded = self
            .store
            .load_application_at(&source)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("managed source not found")?;
        let plan = loaded.plan();
        if after
            .as_ref()
            .is_some_and(|after| !plan.instances().contains_key(after))
        {
            return Err("managed instance cursor not found".into());
        }
        let mut remaining = plan.instances().values().filter(|instance| {
            after
                .as_ref()
                .is_none_or(|after| &instance.identity > after)
        });
        let instances: Vec<_> = remaining
            .by_ref()
            .take(8)
            .map(|instance| ManagedInstance {
                instance: instance.identity.clone(),
                path: instance.path.clone(),
                package: instance.package.clone(),
                presentation: loaded
                    .packages()
                    .iter()
                    .find(|package| package.application_ref() == instance.package)
                    .map(|package| package.manifest().presentation())
                    .unwrap_or_default(),
                structural: instance.entry.is_none(),
                disabled: instance.disabled,
                parent_disabled: instance
                    .parent
                    .as_ref()
                    .is_some_and(|parent| plan.instances()[parent].disabled),
            })
            .collect();
        let next = remaining.next().map(|_| {
            instances
                .last()
                .expect("full managed page")
                .instance
                .clone()
        });
        serde_json::to_value(ManagedInstancesPage {
            source,
            instances,
            next,
        })
        .map_err(|e| e.to_string())
    }
    async fn read_document(&self, input: Value) -> Result<Value> {
        let request: DeploymentDocumentRead =
            serde_json::from_value(input).map_err(|e| e.to_string())?;
        if request.source.state_domain != self.source.state_domain
            || request.source.deployment != self.source.deployment
        {
            return Err("foreign managed deployment source".into());
        }
        let _materialize = self.writes.lock().await;
        let metadata = self
            .store
            .read_application_metadata_at(&request.source)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("managed source not found")?;
        let text = document_text(DeploymentDocument {
            input: metadata.source.input,
            remote_exports: metadata.source.remote_exports,
            packages: metadata.packages,
        })?;
        if request.offset > text.len() || !text.is_char_boundary(request.offset) {
            return Err("invalid document byte offset".into());
        }
        let mut end = text
            .len()
            .min(request.offset.saturating_add(RESOURCE_CHUNK_LIMIT));
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        serde_json::to_value(DeploymentDocumentChunk {
            source: request.source,
            offset: request.offset,
            total_bytes: text.len(),
            text: text[request.offset..end].into(),
            next: (end < text.len()).then_some(end),
        })
        .map_err(|e| e.to_string())
    }
    async fn set_enabled(&self, input: Value) -> Result<Value> {
        let request: InstanceSetEnabled =
            serde_json::from_value(input).map_err(|e| e.to_string())?;
        let _write = self.writes.lock().await;
        let metadata = self.metadata().await?;
        if request.expected_revision != metadata.source.reference.revision {
            return conflict(metadata.source.reference.revision);
        }
        let loaded = self
            .store
            .load_application_at(&metadata.source.reference)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("managed source not found")?;
        let (mut source, packages, plan, _) = loaded.into_parts();
        let Some(instance) = plan.instances().get(&request.instance) else {
            return rejected(ManagementRejection::InstanceUnavailable);
        };
        if request.enabled
            && instance
                .parent
                .as_ref()
                .is_some_and(|parent| plan.instances()[parent].disabled)
        {
            return rejected(ManagementRejection::ParentDisabled);
        }
        let [root, path @ ..] = instance.path.as_slice() else {
            return Err("invalid actual managed path".into());
        };
        let node = source
            .input
            .instances
            .get_mut(root)
            .ok_or("managed root disappeared")?;
        if path.is_empty() {
            node.disabled = !request.enabled;
        } else {
            if let Some(patch) = node.overrides.iter_mut().find(|patch| patch.path == path) {
                patch.disabled = Some(!request.enabled);
            } else {
                node.overrides
                    .push(maka_plugin_core::composition::Override {
                        path: path.to_vec(),
                        disabled: Some(!request.enabled),
                        ..Default::default()
                    });
            }
        }
        // Effective disabled may come from an ancestor. Persist the user's own
        // explicit intent even when that effective projection already matches.
        self.commit(
            request.expected_revision,
            source.input,
            source.remote_exports,
            packages,
            |source| source,
        )
        .await
    }
    async fn install(&self, input: Value, context: Context) -> Result<Value> {
        let request: PackageInstall =
            serde_json::from_value(input).map_err(|error| error.to_string())?;
        let _write = self.writes.lock().await;
        let metadata = self.metadata().await?;
        if request.expected_revision != metadata.source.reference.revision {
            return conflict(metadata.source.reference.revision);
        }
        let resource = context
            .attachments()
            .get("package")
            .ok_or("package bundle required")?
            .clone();
        let mut ticket = context
            .scope()
            .resources
            .reserve()
            .map_err(|error| error.to_string())?;
        ticket.start();
        let parsed = tokio::task::spawn_blocking(move || {
            let parsed = read_bundle(&resource);
            drop(resource);
            ticket.complete(Ok(()));
            parsed
        })
        .await
        .map_err(|error| format!("package validation worker failed: {error}"))?;
        let package = match parsed {
            Ok(package) => package,
            Err(_) => return rejected(ManagementRejection::InvalidBundle),
        };
        self.install_package(request.expected_revision, package, metadata)
            .await
    }
    async fn install_package(
        &self,
        expected_revision: u64,
        package: Package,
        metadata: maka_plugin_core::deployment::management::ManagedDeployment,
    ) -> Result<Value> {
        let reference = package.application_ref();
        let loaded = self
            .store
            .load_application_at(&metadata.source.reference)
            .await
            .map_err(|error| error.to_string())?
            .ok_or("managed source not found")?;
        let (source, mut packages, _, _) = loaded.into_parts();
        if !packages
            .iter()
            .any(|old| old.application_ref() == reference)
        {
            packages.push(package);
        }
        self.commit(
            expected_revision,
            source.input,
            source.remote_exports,
            packages,
            move |source| PackageInstalled {
                source,
                package: reference,
            },
        )
        .await
    }
    async fn replace(&self, input: Value, context: Context) -> Result<Value> {
        let request: DeploymentReplace =
            serde_json::from_value(input).map_err(|error| error.to_string())?;
        let _write = self.writes.lock().await;
        let metadata = self.metadata().await?;
        if request.expected_revision != metadata.source.reference.revision {
            return conflict(metadata.source.reference.revision);
        }
        let resource = context
            .attachments()
            .get("document")
            .ok_or("source document required")?
            .clone();
        let bundles = context.attachments().get("packages").cloned();
        let mut ticket = context
            .scope()
            .resources
            .reserve()
            .map_err(|e| e.to_string())?;
        ticket.start();
        let parsed = tokio::task::spawn_blocking(move || {
            let parsed = (|| {
                let document = read_document_resource(&resource)
                    .map_err(|error| (ManagementRejection::InvalidDocument, error))?;
                let packages = match &bundles {
                    Some(resource) => read_package_bundles(resource)
                        .map_err(|error| (ManagementRejection::InvalidBundle, error))?,
                    None => Vec::new(),
                };
                Ok((document, packages))
            })();
            drop(resource);
            drop(bundles);
            ticket.complete(Ok(()));
            parsed
        })
        .await
        .map_err(|e| format!("document validation worker failed: {e}"))?;
        let (document, packages) = match parsed {
            Ok(parsed) => parsed,
            Err((reason, error)) => return rejected_diagnostic(reason, error),
        };
        self.replace_document(request.expected_revision, document, metadata, packages)
            .await
    }
    async fn replace_document(
        &self,
        expected_revision: u64,
        document: DeploymentDocument,
        metadata: maka_plugin_core::deployment::management::ManagedDeployment,
        supplied: Vec<Package>,
    ) -> Result<Value> {
        if document.input.environment != self.environment
            || (self.environment.location == ExecutionLocation::Host
                && !document.remote_exports.is_empty())
        {
            return rejected(ManagementRejection::ExecutionEnvironment);
        }
        let desired: BTreeSet<_> = document.packages.iter().cloned().collect();
        if desired.len() != document.packages.len() {
            return rejected_diagnostic(
                ManagementRejection::InvalidDocument,
                "duplicate document package reference".into(),
            );
        }
        let mut added = BTreeMap::new();
        for package in supplied {
            let reference = package.application_ref();
            if !desired.contains(&reference) || added.insert(reference, package).is_some() {
                return rejected_diagnostic(
                    ManagementRejection::InvalidBundle,
                    "supplied packages must be distinct and selected by the document".into(),
                );
            }
        }
        if desired.iter().any(|reference| {
            !metadata.packages.contains(reference) && !added.contains_key(reference)
        }) {
            return rejected(ManagementRejection::PackageUnavailable);
        }
        let loaded = self
            .store
            .load_application_at(&metadata.source.reference)
            .await
            .map_err(|error| error.to_string())?
            .ok_or("managed source not found")?;
        let mut available: BTreeMap<_, _> = loaded
            .packages()
            .iter()
            .map(|package| (package.application_ref(), package.clone()))
            .collect();
        available.extend(added);
        let packages = document
            .packages
            .into_iter()
            .map(|reference| {
                available
                    .get(&reference)
                    .cloned()
                    .ok_or("installed package disappeared".to_string())
            })
            .collect::<Result<Vec<_>>>()?;
        self.commit(
            expected_revision,
            document.input,
            document.remote_exports,
            packages,
            |source| source,
        )
        .await
    }
    async fn export_package(&self, input: Value, context: Context) -> Result<Value> {
        let request: PackageBundleRead =
            serde_json::from_value(input).map_err(|error| error.to_string())?;
        let package = {
            let _read = self.writes.lock().await;
            let loaded = self.source_at(Some(request.source)).await?;
            loaded
                .packages()
                .iter()
                .find(|package| package.application_ref() == request.package)
                .cloned()
                .ok_or("package is not installed in this source")?
        };
        let mut ticket = context
            .scope()
            .resources
            .reserve()
            .map_err(|error| error.to_string())?;
        ticket.start();
        let bytes = tokio::task::spawn_blocking(move || {
            let bytes = package.to_bundle();
            drop(package);
            ticket.complete(Ok(()));
            bytes
        })
        .await
        .map_err(|error| format!("package export worker failed: {error}"))?;
        let text = String::from_utf8(bytes).map_err(|error| error.to_string())?;
        let mut offset = 0;
        while offset < text.len() {
            let mut end = (offset + 16 * 1024).min(text.len());
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            context
                .emit(
                    serde_json::to_value(PackageBundleExport::Chunk {
                        offset,
                        total_bytes: text.len(),
                        text: text[offset..end].into(),
                    })
                    .map_err(|error| error.to_string())?,
                )
                .await?;
            offset = end;
        }
        serde_json::to_value(PackageBundleExport::Complete {}).map_err(|error| error.to_string())
    }
    async fn commit<T: serde::Serialize>(
        &self,
        expected: u64,
        input: Input,
        observations: Vec<maka_plugin_core::deployment::RemoteObservation>,
        packages: Vec<Package>,
        result: impl FnOnce(DeploymentRef) -> T,
    ) -> Result<Value> {
        if input.environment != self.environment {
            return rejected(ManagementRejection::ExecutionEnvironment);
        }
        if let Err(error) = validate_application(&input, &observations, &packages) {
            return rejected_diagnostic(ManagementRejection::InvalidSource, error.to_string());
        }
        match self
            .store
            .commit_application(
                self.source.deployment,
                expected,
                input,
                observations,
                packages,
            )
            .await
        {
            Ok(source) => serde_json::to_value(ManagementResult::Committed {
                value: result(source),
            })
            .map_err(|error| error.to_string()),
            Err(StoreError::RevisionConflict { actual, .. }) => conflict(
                actual
                    .parse()
                    .map_err(|_| "invalid managed revision conflict")?,
            ),
            // SQL and COMMIT uncertainty must never be converted to a known refusal.
            Err(error) => Err(error.to_string()),
        }
    }
}
fn rejected(reason: ManagementRejection) -> Result<Value> {
    serde_json::to_value(ManagementResult::<DeploymentRef>::Rejected {
        reason,
        diagnostic: None,
    })
    .map_err(|error| error.to_string())
}
fn rejected_diagnostic(reason: ManagementRejection, message: String) -> Result<Value> {
    serde_json::to_value(ManagementResult::<DeploymentRef>::Rejected {
        reason,
        diagnostic: Some(message),
    })
    .map_err(|e| e.to_string())
}
fn conflict(current_revision: u64) -> Result<Value> {
    serde_json::to_value(ManagementResult::<DeploymentRef>::Conflict { current_revision })
        .map_err(|error| error.to_string())
}

impl Handler for Manager {
    fn call(
        &self,
        method: String,
        input: Value,
        context: Context,
    ) -> BoxFuture<'static, Result<Value>> {
        let manager = self.clone();
        Box::pin(async move {
            match method.as_str() {
                "read" => {
                    serde_json::from_value::<DeploymentRead>(input)
                        .map_err(|error| error.to_string())?;
                    serde_json::to_value(manager.metadata().await?)
                        .map_err(|error| error.to_string())
                }
                "instances" => manager.instances(input).await,
                "readDocument" => manager.read_document(input).await,
                "readSettings" => manager.read_settings(input).await,
                "configure" => manager.configure(input).await,
                "bindingCandidates" => manager.binding_candidates(input).await,
                "packageSettings" => manager.package_settings(input).await,
                "editComposition" => manager.edit_composition(input).await,
                "setEnabled" => manager.set_enabled(input).await,
                "install" => manager.install(input, context).await,
                "installSource" => manager.install_source(input).await,
                "installUrl" => manager.install_url(input, context).await,
                "readPackage" => manager.read_package(input).await,
                "exportPackage" => manager.export_package(input, context).await,
                "replaceSource" => manager.replace_source(input).await,
                "replace" => manager.replace(input, context).await,
                _ => Err("unknown deployment management method".into()),
            }
        })
    }
}
impl NativeOwner for Manager {
    fn prepare_retirement(&self) -> Option<Box<dyn crate::application::NativeRetirement>> {
        Some(Box::new(()))
    }
    fn execution_basis(&self) -> Option<Value> {
        Some(serde_json::json!({
            "stateDomain": self.source.state_domain,
            "deployment": self.source.deployment,
            "environment": self.environment,
        }))
    }
    fn close(&self) -> BoxFuture<'static, Result<()>> {
        // Accepted requests and their blocking/SQL work belong to original
        // Host execution Scopes; no independent activation work is started.
        Box::pin(async { Ok(()) })
    }
}
fn document_text(document: DeploymentDocument) -> Result<String> {
    serde_json::to_string_pretty(&document).map_err(|error| error.to_string())
}
fn read_document_resource(
    resource: &Arc<dyn maka_capabilities::call::ReadResource>,
) -> Result<DeploymentDocument> {
    use maka_capabilities::call::ResourceEncoding;
    if resource.resource_type() != maka_plugin_core::contract::text_resource_type()
        || resource.encoding() != ResourceEncoding::Utf8
        || resource.bytes() == 0
    {
        return Err("source document must be nonempty immutable UTF-8".into());
    }
    let length = resource.bytes();
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(length)
        .map_err(|_| "package resource allocation failed")?;
    while bytes.len() < length {
        let offset = bytes.len();
        let mut end = length.min(offset + RESOURCE_CHUNK_LIMIT);
        let mut chunk = resource.read(offset..end);
        // Snapshots reject ranges inside a Unicode scalar. Try at most its
        // three possible trailing byte boundaries, as the original transport does.
        for _ in 0..3 {
            if chunk.is_ok() || end <= offset + 1 {
                break;
            }
            end -= 1;
            chunk = resource.read(offset..end);
        }
        let chunk = chunk?;
        if chunk.len() != end - offset || chunk.is_empty() {
            return Err("document snapshot length changed".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}
fn read_bundle(resource: &Arc<dyn maka_capabilities::call::ReadResource>) -> Result<Package> {
    let bytes = read_binary_resource(resource)?;
    Package::from_bundle(&bytes).map_err(|error| error.to_string())
}
fn read_package_bundles(
    resource: &Arc<dyn maka_capabilities::call::ReadResource>,
) -> Result<Vec<Package>> {
    let bytes = read_binary_resource(resource)?;
    let bundles: Vec<&serde_json::value::RawValue> =
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    bundles
        .into_iter()
        .map(|bundle| {
            Package::from_bundle(bundle.get().as_bytes()).map_err(|error| error.to_string())
        })
        .collect()
}
fn read_binary_resource(
    resource: &Arc<dyn maka_capabilities::call::ReadResource>,
) -> Result<Vec<u8>> {
    use maka_capabilities::call::ResourceEncoding;
    let length = resource.bytes();
    if resource.resource_type() != binary_resource_type()
        || resource.encoding() != ResourceEncoding::Bytes
    {
        return Err("invalid immutable package bundle resource".into());
    }
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(length)
        .map_err(|_| "package resource allocation failed")?;
    for offset in (0..length).step_by(RESOURCE_CHUNK_LIMIT) {
        let end = offset.saturating_add(RESOURCE_CHUNK_LIMIT).min(length);
        let chunk = resource.read(offset..end)?;
        if chunk.len() != end - offset {
            return Err("package bundle snapshot length changed".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

pub(super) fn provide(native: &mut NativeRegistry) -> Result<()> {
    provide_manager(native, self::native().implementation, None)
}

/// Makes a fixed target available to an explicitly composed native entry. This
/// does not start an entry, publish a binding, or grant a caller any permission.
pub fn provide_target(
    native: &mut NativeRegistry,
    implementation: String,
    target: ManagementTarget,
) -> Result<()> {
    provide_manager(native, implementation, Some(target))
}

fn provide_manager(
    native: &mut NativeRegistry,
    implementation: String,
    target: Option<ManagementTarget>,
) -> Result<()> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Configuration {}
    // All explicitly composed manager instances in this original Application
    // share one bounded source-materialization lane. CAS remains the SQL authority.
    let writes = Arc::new(tokio::sync::Mutex::new(()));
    native.insert(
        implementation,
        Arc::new(move |context, configuration| {
            let writes = writes.clone();
            let target = target.clone();
            Box::pin(async move {
                let manager = (|| {
                    serde_json::from_value::<Configuration>(configuration)
                        .map_err(|error| error.to_string())?;
                    let persistence = context
                        .persistence()
                        .ok_or("deployment management requires the original persisted Root")?;
                    let manager = match target {
                        Some(target) => {
                            if !Arc::ptr_eq(persistence.store(), &target.0.store) {
                                return Err(
                                    "management target requires the same original Root owner"
                                        .into(),
                                );
                            }
                            target.0
                        }
                        None => Manager {
                            source: persistence.source().clone(),
                            store: persistence.store().clone(),
                            environment: maka_plugin_core::composition::Environment {
                                location: ExecutionLocation::Host,
                                presentation: None,
                            },
                            writes,
                        },
                    };
                    Ok::<_, String>(Arc::new(manager))
                })();
                match manager {
                    Ok(manager) => NativeActivation {
                        exports: Ok(BTreeMap::from([(
                            "Management".into(),
                            Published {
                                contract: deployment_manager_contract(),
                                value: manager.clone() as Arc<dyn Handler>,
                            },
                        )])),
                        owner: manager,
                    },
                    Err(error) => NativeActivation {
                        exports: Err(error),
                        owner: Arc::new(Uninitialized),
                    },
                }
            })
        }),
    )
}

struct Uninitialized;
impl NativeOwner for Uninitialized {
    fn prepare_retirement(&self) -> Option<Box<dyn crate::application::NativeRetirement>> {
        Some(Box::new(()))
    }
    fn close(&self) -> BoxFuture<'static, Result<()>> {
        Box::pin(async { Ok(()) })
    }
}

pub fn native() -> maka_plugin_core::package::NativeDefinition {
    maka_plugin_core::package::NativeDefinition::new(
        DEPLOYMENT_MANAGER,
        serde_json::json!({"type":"object","properties":{},"required":[],"additionalProperties":false}),
        [(
            "Management",
            maka_plugin_core::deployment::management::deployment_manager_contract(),
        )],
    )
}

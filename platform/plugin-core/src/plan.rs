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

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{
    Error,
    composition::{self, Configuration, Input, InstanceId, Node, Override, PackageUse, Target},
    contract::{Availability, Export, Import, Transport},
    package::{EntryDeclaration, PackageRef, PackageSelection, Packages, UiContribution, UiEntry},
};

/// Remote declarations are observations supplied by the execution adapter.
/// They establish compatibility, never caller authority or runtime readiness.
pub type RemoteExports = BTreeMap<RemoteCapability, Export>;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteCapability {
    pub deployment: String,
    pub instance: InstanceId,
    pub export: String,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Provider {
    Local {
        instance: InstanceId,
        export: String,
    },
    Remote {
        capability: RemoteCapability,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Binding {
    pub provider: Provider,
    pub declaration: Arc<Export>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    pub identity: InstanceId,
    pub path: Vec<String>,
    pub parent: Option<InstanceId>,
    pub package: PackageRef,
    pub disabled: bool,
    pub configuration: Value,
    pub entry: Option<InstanceEntry>,
    pub bindings: BTreeMap<String, Vec<Binding>>,
    pub exports: BTreeMap<String, Binding>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", content = "declaration", rename_all = "snake_case")]
pub enum InstanceEntry {
    Host(Arc<EntryDeclaration>),
    Ui(Arc<UiEntry>),
}

impl InstanceEntry {
    pub fn imports(&self) -> &BTreeMap<String, Import> {
        match self {
            Self::Host(entry) => &entry.imports,
            Self::Ui(entry) => &entry.imports,
        }
    }
}

#[derive(PartialEq, Serialize)]
pub(crate) struct ActivationBasis<'a> {
    identity: &'a InstanceId,
    parent: Option<&'a InstanceId>,
    package: Option<&'a PackageRef>,
    disabled: bool,
    configuration: &'a Value,
    entry: Option<&'a InstanceEntry>,
    bindings: &'a BTreeMap<String, Vec<Binding>>,
    exports: &'a BTreeMap<String, Binding>,
}

pub(crate) enum Dependency<'a> {
    Local(&'a InstanceId),
    Remote(&'a RemoteCapability),
}

impl Instance {
    pub(crate) fn activation_basis(&self) -> ActivationBasis<'_> {
        ActivationBasis {
            identity: &self.identity,
            parent: self.parent.as_ref(),
            package: self.entry.as_ref().map(|_| &self.package),
            disabled: self.disabled,
            configuration: &self.configuration,
            entry: self.entry.as_ref(),
            bindings: &self.bindings,
            exports: &self.exports,
        }
    }

    pub(crate) fn dependencies(&self) -> impl Iterator<Item = Dependency<'_>> {
        self.parent.iter().map(Dependency::Local).chain(
            self.entry
                .iter()
                .flat_map(|_| self.bindings.values().flatten())
                .map(|binding| match &binding.provider {
                    Provider::Local { instance, .. } => Dependency::Local(instance),
                    Provider::Remote { capability } => Dependency::Remote(capability),
                }),
        )
    }

    pub fn host_entry(&self) -> Option<&EntryDeclaration> {
        match self.entry.as_ref()? {
            InstanceEntry::Host(entry) => Some(entry),
            InstanceEntry::Ui(_) => None,
        }
    }

    pub fn ui_entry(&self) -> Option<&UiEntry> {
        match self.entry.as_ref()? {
            InstanceEntry::Host(_) => None,
            InstanceEntry::Ui(entry) => Some(entry),
        }
    }
}

/// A checked projection; callers retain Input as the sole editable authority.
/// Static checking says nothing about effect authorization or live exports.
#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    instances: BTreeMap<InstanceId, Instance>,
    ui: Option<UiRoot>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UiRoot {
    pub instance: InstanceId,
    pub id: String,
}

#[derive(Debug)]
pub struct PackageChange {
    pub path: Vec<String>,
    pub package: PackageRef,
}

impl Plan {
    pub fn prepare(
        input: &Input,
        packages: &Packages,
        remote: &RemoteExports,
    ) -> Result<Self, Error> {
        Self::prepare_replacing(input, packages, remote, |_| None).map(|(plan, _)| plan)
    }

    /// Check an atomic package update through the same template expansion and
    /// binding validation as an ordinary source. The returned package changes
    /// must be applied to Input and checked against the real immutable packages
    /// before persistence; this projection is never a second source authority.
    pub fn prepare_replacing(
        input: &Input,
        packages: &Packages,
        remote: &RemoteExports,
        replace: impl Fn(&PackageRef) -> Option<PackageRef>,
    ) -> Result<(Self, Vec<PackageChange>), Error> {
        composition::validate_nodes(&input.instances)?;
        if let Some(ui) = &input.ui {
            ui.validate()?;
        }
        let mut builder = Builder {
            packages,
            nodes: BTreeMap::new(),
            aliases: BTreeMap::new(),
            replace: &replace,
            package_changes: Vec::new(),
        };
        builder.expand(&input.instances, &[], None, &BTreeMap::new(), &[], false)?;
        let remote = remote
            .iter()
            .map(|(capability, declaration)| (capability.clone(), Arc::new(declaration.clone())))
            .collect();
        let resolver = Resolver {
            nodes: &builder.nodes,
            aliases: &builder.aliases,
            remote: &remote,
            resolved: RefCell::new(BTreeMap::new()),
        };
        let mut instances = BTreeMap::new();
        for (id, pending) in &builder.nodes {
            let mut bindings = BTreeMap::new();
            let mut exports = BTreeMap::new();
            if !pending.instance.disabled {
                for name in pending.bindings.keys() {
                    if !pending.imports.contains_key(name) {
                        return Err(Error::Composition(format!(
                            "undeclared import at {:?}: {name}",
                            pending.instance.path
                        )));
                    }
                }
                for name in pending.imports.keys() {
                    bindings.insert(
                        name.clone(),
                        resolver.resolve(Resolving::Import(id.clone(), name.clone()))?,
                    );
                }
                for name in pending.exports.keys() {
                    exports.insert(
                        name.clone(),
                        resolver
                            .resolve(Resolving::Export(id.clone(), name.clone()))?
                            .remove(0),
                    );
                }
            }
            let mut instance = pending.instance.clone();
            instance.bindings = bindings;
            instance.exports = exports;
            instances.insert(id.clone(), instance);
        }
        validate_dependencies(&instances)?;
        let ui = input
            .ui
            .as_ref()
            .map(|target| {
                let id = builder.aliases.get(&target.path).ok_or_else(|| {
                    Error::Composition(format!(
                        "selected UI instance does not exist: {:?}",
                        target.path
                    ))
                })?;
                let instance = &instances[id];
                if instance.disabled {
                    return Err(Error::Composition(
                        "selected UI instance is disabled".into(),
                    ));
                }
                let entry = instance.ui_entry().ok_or_else(|| {
                    Error::Composition("selected UI instance has no UI entry".into())
                })?;
                if !matches!(
                    entry.contributions.get(&target.id),
                    Some(UiContribution::Root)
                ) {
                    return Err(Error::Composition(format!(
                        "selected UI contribution is not a root: {}",
                        target.id
                    )));
                }
                Ok(UiRoot {
                    instance: id.clone(),
                    id: target.id.clone(),
                })
            })
            .transpose()?;
        Ok((Self { instances, ui }, builder.package_changes))
    }

    pub fn instances(&self) -> &BTreeMap<InstanceId, Instance> {
        &self.instances
    }

    pub fn ui(&self) -> Option<&UiRoot> {
        self.ui.as_ref()
    }

    /// One instance's own definition, independent of its providers' definitions.
    pub fn definition_basis(&self, instance: &InstanceId) -> Result<String, Error> {
        let instance = self
            .instances
            .get(instance)
            .ok_or_else(|| Error::Composition("definition basis instance is missing".into()))?;
        Ok(hash_basis(instance.activation_basis()))
    }

    /// Source-driven lifetime of one consumer and its transitive effective providers.
    pub fn binding_basis(&self, instance: &InstanceId) -> Result<String, Error> {
        if !self.instances.contains_key(instance) {
            return Err(Error::Composition(
                "binding basis instance is missing".into(),
            ));
        }
        let mut members = BTreeSet::new();
        let mut pending = vec![instance];
        while let Some(id) = pending.pop() {
            if !members.insert(id) {
                continue;
            }
            for dependency in self.instances[id].dependencies() {
                if let Dependency::Local(id) = dependency {
                    pending.push(id);
                }
            }
        }
        let projection: Vec<_> = members
            .into_iter()
            .map(|id| self.instances[id].activation_basis())
            .collect();
        Ok(hash_basis(projection))
    }
}

fn hash_basis(projection: impl Serialize) -> String {
    let mut value = serde_json::to_value(projection).expect("activation basis is JSON");
    value.sort_all_objects();
    let encoded = serde_json::to_vec(&value).expect("activation basis is JSON");
    format!("sha256-{}", hex::encode(Sha256::digest(encoded)))
}

enum PendingExport {
    Actual(Arc<Export>),
    Forward(Target),
}

struct Pending<'a> {
    instance: Instance,
    bindings: BTreeMap<String, Vec<Target>>,
    imports: &'a BTreeMap<String, Import>,
    exports: BTreeMap<String, PendingExport>,
}

struct Builder<'a> {
    packages: &'a Packages,
    nodes: BTreeMap<InstanceId, Pending<'a>>,
    aliases: BTreeMap<Vec<String>, InstanceId>,
    replace: &'a dyn Fn(&PackageRef) -> Option<PackageRef>,
    package_changes: Vec<PackageChange>,
}

impl<'a> Builder<'a> {
    fn expand(
        &mut self,
        nodes: &BTreeMap<String, Node>,
        namespace: &[String],
        parent: Option<&InstanceId>,
        parameters: &BTreeMap<String, Value>,
        overrides: &[Override],
        ancestor_disabled: bool,
    ) -> Result<(), Error> {
        #[derive(PartialEq)]
        struct ExpansionState {
            package: PackageRef,
            overrides: Vec<Override>,
        }
        enum Task {
            Enter {
                alias: String,
                node: Box<Node>,
                namespace: Vec<String>,
                parent: Option<InstanceId>,
                parameters: Arc<BTreeMap<String, Value>>,
                overrides: Arc<[Override]>,
                ancestor_disabled: bool,
            },
            Exit,
        }
        fn schedule(
            tasks: &mut Vec<Task>,
            nodes: &BTreeMap<String, Node>,
            namespace: &[String],
            parent: Option<&InstanceId>,
            parameters: &BTreeMap<String, Value>,
            overrides: &[Override],
            ancestor_disabled: bool,
        ) -> Result<(), Error> {
            composition::validate_nodes(nodes)?;
            for patch in overrides {
                if !nodes.contains_key(&patch.path[0]) {
                    return Err(Error::Composition(format!(
                        "override target disappeared: {:?}",
                        patch.path
                    )));
                }
            }
            let parameters = Arc::new(parameters.clone());
            let overrides: Arc<[Override]> = overrides.into();
            for (alias, node) in nodes.iter().rev() {
                tasks.push(Task::Enter {
                    alias: alias.clone(),
                    node: Box::new(node.clone()),
                    namespace: namespace.to_vec(),
                    parent: parent.cloned(),
                    parameters: parameters.clone(),
                    overrides: overrides.clone(),
                    ancestor_disabled,
                });
            }
            Ok(())
        }
        let mut tasks = Vec::new();
        let mut active = Vec::new();
        schedule(
            &mut tasks,
            nodes,
            namespace,
            parent,
            parameters,
            overrides,
            ancestor_disabled,
        )?;
        while let Some(task) = tasks.pop() {
            let Task::Enter {
                alias,
                node,
                namespace,
                parent,
                parameters,
                overrides,
                ancestor_disabled,
            } = task
            else {
                active.pop();
                continue;
            };
            let mut node = *node;
            let mut child_overrides = BTreeMap::new();
            for patch in &node.overrides {
                child_overrides.insert(patch.path.clone(), patch.clone());
            }
            for patch in overrides.iter().filter(|patch| patch.path[0] == alias) {
                if patch.path.len() == 1 {
                    if let Some(package) = &patch.package {
                        node.package = package.clone().into();
                    }
                    if let Some(use_package) = patch.use_package {
                        node.use_package = use_package;
                    }
                    for (field, value) in &patch.parameters {
                        node.parameters.parameters.remove(field);
                        node.parameters.values.insert(field.clone(), value.clone());
                    }
                    for (field, value) in &patch.configuration {
                        node.configuration.parameters.remove(field);
                        node.configuration
                            .values
                            .insert(field.clone(), value.clone());
                    }
                    node.bindings.extend(patch.bindings.clone());
                    if let Some(disabled) = patch.disabled {
                        node.disabled = disabled;
                    }
                } else {
                    let mut relative = patch.clone();
                    relative.path.remove(0);
                    let combined =
                        child_overrides
                            .entry(relative.path.clone())
                            .or_insert_with(|| Override {
                                path: relative.path.clone(),
                                configuration: BTreeMap::new(),
                                bindings: BTreeMap::new(),
                                disabled: None,
                                ..Override::default()
                            });
                    combined.configuration.extend(relative.configuration);
                    combined.bindings.extend(relative.bindings);
                    combined.parameters.extend(relative.parameters);
                    if relative.package.is_some() {
                        combined.package = relative.package;
                    }
                    if relative.use_package.is_some() {
                        combined.use_package = relative.use_package;
                    }
                    if relative.disabled.is_some() {
                        combined.disabled = relative.disabled;
                    }
                }
            }
            let child_overrides: Vec<_> = child_overrides.into_values().collect();
            node.validate()?;
            let mut identity = parent
                .as_ref()
                .map_or_else(Vec::new, |parent| parent.0.clone());
            identity.push(node.key);
            let identity = InstanceId(identity);
            identity.validate()?;
            let mut path = namespace.to_vec();
            path.push(alias.clone());
            let package = match &node.package {
                PackageSelection::Pinned { package } => package.clone(),
                PackageSelection::Current => parent
                    .as_ref()
                    .map(|parent| self.nodes[parent].instance.package.clone())
                    .ok_or_else(|| {
                        Error::Composition(
                            "deployment roots require a pinned package revision".into(),
                        )
                    })?,
            };
            let package = match (self.replace)(&package).filter(|next| next != &package) {
                Some(next) => {
                    self.package_changes.push(PackageChange {
                        path: path.clone(),
                        package: next.clone(),
                    });
                    next
                }
                None => package,
            };
            let declaration = self.packages.get(&package).ok_or_else(|| {
                Error::Composition(format!(
                    "missing pinned package: {}@{}",
                    package.id, package.revision
                ))
            })?;
            let configuration = Value::Object(
                node.configuration
                    .resolve(&parameters)?
                    .into_iter()
                    .collect(),
            );
            let disabled = ancestor_disabled || node.disabled;
            let (entry, imports, exports) = match node.use_package {
                PackageUse::Host => {
                    if !child_overrides.is_empty() || node.parameters != Configuration::default() {
                        return Err(Error::Composition(
                            "executable instance cannot own template parameters or child overrides"
                                .into(),
                        ));
                    }
                    let entry = declaration.host.as_ref().ok_or_else(|| {
                        Error::Composition(format!("package {} has no Host entry", package.id))
                    })?;
                    crate::validate_value(&entry.configuration, &configuration)?;
                    let exports = entry
                        .exports
                        .iter()
                        .map(|(name, export)| {
                            (
                                name.clone(),
                                PendingExport::Actual(Arc::new(export.clone())),
                            )
                        })
                        .collect();
                    (
                        Some(InstanceEntry::Host(Arc::new(entry.clone()))),
                        &entry.imports,
                        exports,
                    )
                }
                PackageUse::Ui => {
                    if !child_overrides.is_empty() || node.parameters != Configuration::default() {
                        return Err(Error::Composition(
                            "UI instance cannot own template parameters or child overrides".into(),
                        ));
                    }
                    let entry = declaration.ui.as_ref().ok_or_else(|| {
                        Error::Composition(format!("package {} has no UI entry", package.id))
                    })?;
                    crate::validate_value(&entry.configuration, &configuration)?;
                    (
                        Some(InstanceEntry::Ui(Arc::new(entry.clone()))),
                        &entry.imports,
                        BTreeMap::new(),
                    )
                }
                PackageUse::Composition => {
                    if configuration != serde_json::json!({}) {
                        return Err(Error::Composition("structural instances use template parameters, not executable configuration".into()));
                    }
                    let template = declaration.composition.as_ref().ok_or_else(|| {
                        Error::Composition(format!("package {} has no composition", package.id))
                    })?;
                    (
                        None,
                        &template.imports,
                        template
                            .exports
                            .iter()
                            .map(|(name, target)| {
                                (name.clone(), PendingExport::Forward(target.clone()))
                            })
                            .collect(),
                    )
                }
            };
            self.aliases.insert(path.clone(), identity.clone());
            self.nodes.insert(
                identity.clone(),
                Pending {
                    instance: Instance {
                        identity: identity.clone(),
                        path: path.clone(),
                        parent: parent.clone(),
                        package: package.clone(),
                        disabled,
                        configuration,
                        entry,
                        bindings: BTreeMap::new(),
                        exports: BTreeMap::new(),
                    },
                    bindings: node.bindings,
                    imports,
                    exports,
                },
            );
            if node.use_package == PackageUse::Composition {
                let template = declaration.composition.as_ref().unwrap();
                let mut supplied = node.parameters.resolve(&parameters)?;
                for name in supplied.keys() {
                    if !template.parameters.contains_key(name) {
                        return Err(Error::Composition(format!(
                            "undeclared template parameter: {name}"
                        )));
                    }
                }
                for (name, parameter) in &template.parameters {
                    if !supplied.contains_key(name) {
                        supplied.insert(
                            name.clone(),
                            parameter.default.clone().ok_or_else(|| {
                                Error::Composition(format!("missing template parameter: {name}"))
                            })?,
                        );
                    }
                    crate::validate_value(&parameter.schema, &supplied[name])?;
                }
                // Only package selection and effective child overrides determine topology.
                // Repeated packages with shrinking override paths can still terminate.
                let state = ExpansionState {
                    package,
                    overrides: child_overrides.clone(),
                };
                if active.contains(&state) {
                    return Err(Error::Composition("cyclic composition expansion".into()));
                }
                active.push(state);
                tasks.push(Task::Exit);
                schedule(
                    &mut tasks,
                    &template.children,
                    &path,
                    Some(&identity),
                    &supplied,
                    &child_overrides,
                    disabled,
                )?;
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Resolving {
    Import(InstanceId, String),
    Export(InstanceId, String),
}

struct Resolver<'a> {
    nodes: &'a BTreeMap<InstanceId, Pending<'a>>,
    aliases: &'a BTreeMap<Vec<String>, InstanceId>,
    remote: &'a BTreeMap<RemoteCapability, Arc<Export>>,
    resolved: RefCell<BTreeMap<Resolving, Vec<Binding>>>,
}

impl Resolver<'_> {
    fn resolve(&self, root: Resolving) -> Result<Vec<Binding>, Error> {
        let mut resolved = self.resolved.borrow_mut();
        let mut active = BTreeSet::new();
        let mut tasks = vec![(root.clone(), false)];
        while let Some((key, finishing)) = tasks.pop() {
            if resolved.contains_key(&key) {
                continue;
            }
            let (instance, name) = match &key {
                Resolving::Import(instance, name) | Resolving::Export(instance, name) => {
                    (instance, name)
                }
            };
            let pending = &self.nodes[instance];
            let (namespace, owner, targets) = match &key {
                Resolving::Import(_, _) => {
                    if pending.instance.disabled {
                        return Err(Error::Composition(
                            "binding to a disabled structural instance".into(),
                        ));
                    }
                    if !pending.imports.contains_key(name) {
                        return Err(Error::Composition(format!(
                            "undeclared imported binding: {name}"
                        )));
                    }
                    (
                        &pending.instance.path[..pending.instance.path.len() - 1],
                        pending.instance.parent.as_ref(),
                        pending.bindings.get(name).map_or(&[][..], Vec::as_slice),
                    )
                }
                Resolving::Export(_, _) => {
                    if pending.instance.disabled {
                        return Err(Error::Composition(
                            "binding selects a disabled provider".into(),
                        ));
                    }
                    let export = pending
                        .exports
                        .get(name)
                        .ok_or_else(|| Error::Composition(format!("missing export: {name}")))?;
                    let targets = match export {
                        PendingExport::Actual(_) => &[][..],
                        PendingExport::Forward(target) => std::slice::from_ref(target),
                    };
                    (pending.instance.path.as_slice(), Some(instance), targets)
                }
            };
            if !finishing {
                if !active.insert(key.clone()) {
                    let message = match key {
                        Resolving::Import(_, _) => "cyclic import forwarding",
                        Resolving::Export(_, _) => "cyclic export forwarding",
                    };
                    return Err(Error::Composition(message.into()));
                }
                tasks.push((key.clone(), true));
                for target in targets.iter().rev() {
                    if let Some(dependency) = self.target_key(target, namespace, owner)? {
                        tasks.push((dependency, false));
                    }
                }
                continue;
            }
            let mut bindings = Vec::new();
            for target in targets {
                bindings.extend(self.target_result(target, namespace, owner, &resolved)?);
            }
            match &key {
                Resolving::Import(_, _) => {
                    let unique: BTreeSet<_> =
                        bindings.iter().map(|binding| &binding.provider).collect();
                    if unique.len() != bindings.len() {
                        return Err(Error::Composition(format!(
                            "duplicate provider in binding: {name}"
                        )));
                    }
                    let import = &pending.imports[name];
                    for binding in &bindings {
                        if !import.contract.accepts(&binding.declaration.contract) {
                            return Err(Error::Contract(format!(
                                "import {name} does not accept its bound export"
                            )));
                        }
                    }
                    let guaranteed = bindings
                        .iter()
                        .filter(|binding| {
                            binding.declaration.availability == Availability::Required
                        })
                        .count();
                    if !import.cardinality.accepts(bindings.len(), guaranteed) {
                        return Err(Error::Contract(format!(
                            "import cardinality is not satisfied: {name}"
                        )));
                    }
                }
                Resolving::Export(_, _) => match &pending.exports[name] {
                    PendingExport::Actual(declaration) => bindings.push(Binding {
                        provider: Provider::Local {
                            instance: instance.clone(),
                            export: name.clone(),
                        },
                        declaration: declaration.clone(),
                    }),
                    PendingExport::Forward(_) => {
                        if bindings.len() != 1 {
                            return Err(Error::Composition(
                                "structural export must forward exactly one capability".into(),
                            ));
                        }
                    }
                },
            }
            active.remove(&key);
            resolved.insert(key, bindings);
        }
        Ok(resolved[&root].clone())
    }

    fn target_key(
        &self,
        target: &Target,
        namespace: &[String],
        import_owner: Option<&InstanceId>,
    ) -> Result<Option<Resolving>, Error> {
        match target {
            Target::Instance { path, export } => {
                let mut absolute = namespace.to_vec();
                absolute.extend(path.iter().cloned());
                let instance = self.aliases.get(&absolute).ok_or_else(|| {
                    Error::Composition(format!("missing provider instance: {absolute:?}"))
                })?;
                Ok(Some(Resolving::Export(instance.clone(), export.clone())))
            }
            Target::Import { name } => {
                let owner = import_owner.ok_or_else(|| {
                    Error::Composition("root input cannot refer to an enclosing import".into())
                })?;
                Ok(Some(Resolving::Import(owner.clone(), name.clone())))
            }
            Target::Remote { .. } => Ok(None),
        }
    }

    fn target_result(
        &self,
        target: &Target,
        namespace: &[String],
        import_owner: Option<&InstanceId>,
        resolved: &BTreeMap<Resolving, Vec<Binding>>,
    ) -> Result<Vec<Binding>, Error> {
        if let Some(key) = self.target_key(target, namespace, import_owner)? {
            return Ok(resolved[&key].clone());
        }
        let Target::Remote {
            deployment,
            instance,
            export,
        } = target
        else {
            unreachable!()
        };
        let capability = RemoteCapability {
            deployment: deployment.clone(),
            instance: instance.clone(),
            export: export.clone(),
        };
        let declaration = self.remote.get(&capability).ok_or_else(|| {
            Error::Composition("remote capability has no observed declaration".into())
        })?;
        declaration.contract.validate()?;
        if declaration.contract.transport != Transport::Remote {
            return Err(Error::Contract(
                "local capability cannot cross deployments".into(),
            ));
        }
        Ok(vec![Binding {
            provider: Provider::Remote { capability },
            declaration: declaration.clone(),
        }])
    }
}

fn validate_dependencies(instances: &BTreeMap<InstanceId, Instance>) -> Result<(), Error> {
    let mut done = BTreeSet::new();
    for root in instances.keys() {
        let mut active = BTreeSet::new();
        let mut tasks = vec![(root, false)];
        while let Some((id, finishing)) = tasks.pop() {
            if done.contains(id) {
                continue;
            }
            if finishing {
                active.remove(id);
                done.insert(id);
                continue;
            }
            if !active.insert(id) {
                return Err(Error::Composition("cyclic capability dependency".into()));
            }
            tasks.push((id, true));
            for binding in instances[id].bindings.values().flatten() {
                if let Provider::Local { instance, .. } = &binding.provider {
                    tasks.push((instance, false));
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;

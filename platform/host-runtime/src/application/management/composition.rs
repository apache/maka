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

//! Contract-directed choices and one atomic edit of the original composition.
use super::*;
use maka_event_log::applications::LoadedDeployment;
use maka_plugin_core::{
    composition::{Configuration as Values, Node, PackageUse, Target},
    contract::Availability,
    deployment::management::{
        BindingCandidate, BindingCandidatesPage, BindingCandidatesRead, BindingConsumer,
        CompositionChange, CompositionEdit, ManagedImport, PackageSettingsPage,
        PackageSettingsRead,
    },
    package::{Declaration, EntryDeclaration, PackageRef},
};

fn declaration<'a>(packages: &'a [Package], reference: &PackageRef) -> Result<&'a Declaration> {
    packages
        .iter()
        .find(|package| &package.application_ref() == reference)
        .and_then(|package| package.manifest().application.as_ref())
        .map(|declaration| declaration.declaration())
        .ok_or_else(|| "application package unavailable".into())
}
fn host_entry<'a>(packages: &'a [Package], reference: &PackageRef) -> Result<&'a EntryDeclaration> {
    declaration(packages, reference)?
        .host
        .as_ref()
        .ok_or_else(|| "Host entry unavailable".into())
}
fn package_schema<'a>(
    declaration: &'a Declaration,
    use_package: PackageUse,
) -> Result<std::borrow::Cow<'a, Value>> {
    use std::borrow::Cow;
    match use_package {
        PackageUse::Host => Ok(Cow::Borrowed(
            &declaration
                .host
                .as_ref()
                .ok_or("Host entry unavailable")?
                .configuration,
        )),
        PackageUse::Ui => Ok(Cow::Borrowed(
            &declaration
                .ui
                .as_ref()
                .ok_or("UI entry unavailable")?
                .configuration,
        )),
        PackageUse::Composition => {
            let template = declaration
                .composition
                .as_ref()
                .ok_or("composition unavailable")?;
            let mut definitions = serde_json::Map::new();
            let mut properties = serde_json::Map::new();
            let mut defaults = serde_json::Map::new();
            let mut required = Vec::new();
            for (index, (name, parameter)) in template.parameters.iter().enumerate() {
                let key = index.to_string();
                let prefix = format!("#/$defs/{key}");
                let mut schema = parameter.schema.as_ref().clone();
                relocate_refs(&mut schema, &prefix);
                definitions.insert(key, schema);
                properties.insert(name.clone(), serde_json::json!({"$ref": prefix}));
                match &parameter.default {
                    Some(value) => {
                        defaults.insert(name.clone(), value.clone());
                    }
                    None => required.push(name),
                }
            }
            Ok(Cow::Owned(serde_json::json!({
                "type": "object", "properties": properties, "$defs": definitions,
                "default": defaults, "required": required, "additionalProperties": false,
            })))
        }
    }
}
fn relocate_refs(value: &mut Value, prefix: &str) {
    match value {
        Value::Object(object) => {
            if let Some(Value::String(reference)) = object.get_mut("$ref")
                && let Some(local) = reference
                    .strip_prefix('#')
                    .filter(|local| local.is_empty() || local.starts_with('/'))
            {
                *reference = format!("{prefix}{local}");
            }
            for value in object.values_mut() {
                relocate_refs(value, prefix);
            }
        }
        Value::Array(values) => {
            for value in values {
                relocate_refs(value, prefix);
            }
        }
        _ => {}
    }
}
fn defaults(schema: &Value) -> Value {
    let root = settings::resolved(schema, schema, None);
    if let Some(value) = root
        .get("default")
        .or_else(|| root.get("const"))
        .filter(|v| v.is_object())
    {
        return value.clone();
    }
    let mut values = serde_json::Map::new();
    if let Some(properties) = root.get("properties").and_then(Value::as_object) {
        for (key, property) in properties {
            let property = settings::resolved(property, schema, None);
            if let Some(value) = property.get("default").or_else(|| property.get("const")) {
                values.insert(key.clone(), value.clone());
            }
        }
    }
    Value::Object(values)
}
fn candidate_key(candidate: &BindingCandidate) -> &str {
    match candidate {
        BindingCandidate::Bound { key, .. } | BindingCandidate::Package { key, .. } => key,
    }
}
impl Manager {
    pub(super) async fn source_at(
        &self,
        source: Option<DeploymentRef>,
    ) -> Result<LoadedDeployment> {
        let source = match source {
            Some(source) => source,
            None => self.metadata().await?.source.reference,
        };
        if source.state_domain != self.source.state_domain
            || source.deployment != self.source.deployment
        {
            return Err("foreign managed deployment source".into());
        }
        self.store
            .load_application_at(&source)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "managed source not found".into())
    }
    pub(super) async fn binding_candidates(&self, input: Value) -> Result<Value> {
        let request: BindingCandidatesRead =
            serde_json::from_value(input).map_err(|e| e.to_string())?;
        let _read = self.writes.lock().await;
        let loaded = self.source_at(request.source).await?;
        let plan = loaded.plan();
        let (entry, configuration, current) = match &request.consumer {
            BindingConsumer::Root { name } => {
                let node = loaded
                    .source()
                    .input
                    .instances
                    .get(name)
                    .ok_or("consumer root unavailable")?;
                let instance = plan
                    .instances()
                    .values()
                    .find(|i| i.path == [name.clone()])
                    .ok_or("consumer unavailable")?;
                (
                    instance.host_entry().ok_or("Host consumer required")?,
                    instance
                        .configuration
                        .as_object()
                        .ok_or("consumer configuration is not an object")?
                        .iter()
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect(),
                    node.bindings
                        .get(&request.import)
                        .cloned()
                        .unwrap_or_default(),
                )
            }
            BindingConsumer::Package { package } => (
                host_entry(loaded.packages(), package)?,
                BTreeMap::new(),
                vec![],
            ),
        };
        let import = entry
            .imports
            .get(&request.import)
            .ok_or("consumer import unavailable")?;
        let compatible = |export: &maka_plugin_core::contract::Export| {
            export.availability == Availability::Required
                && import.contract.accepts(&export.contract)
        };
        let mut candidates = vec![];
        for instance in plan.instances().values().filter(|i| !i.disabled) {
            if matches!(&request.consumer, BindingConsumer::Root { name } if instance.path == [name.clone()])
            {
                continue;
            }
            for (name, export) in &instance.exports {
                if compatible(&export.declaration) {
                    let label = format!("{} / {name}", instance.path.join(" / "));
                    candidates.push(BindingCandidate::Bound {
                        key: format!("instance:{label}"),
                        label,
                        presentation: loaded
                            .packages()
                            .iter()
                            .find(|package| package.application_ref() == instance.package)
                            .map(|package| package.manifest().presentation())
                            .unwrap_or_default(),
                        target: Target::Instance {
                            path: instance.path.clone(),
                            export: name.clone(),
                        },
                    });
                }
            }
        }
        for observed in &loaded.source().remote_exports {
            if compatible(&observed.declaration) {
                let remote = &observed.capability;
                let key = format!(
                    "remote:{}:{}:{}",
                    remote.deployment,
                    remote
                        .instance
                        .0
                        .iter()
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                        .join("/"),
                    remote.export
                );
                candidates.push(BindingCandidate::Bound {
                    key,
                    label: format!("{} / {}", remote.deployment, remote.export),
                    presentation: Default::default(),
                    target: Target::Remote {
                        deployment: remote.deployment.clone(),
                        instance: remote.instance.clone(),
                        export: remote.export.clone(),
                    },
                });
            }
        }
        if request.include_packages {
            for package in loaded.packages() {
                if let Some(entry) = package
                    .manifest()
                    .application
                    .as_ref()
                    .and_then(|application| application.host.as_ref())
                {
                    for (name, export) in &entry.exports {
                        if compatible(export) {
                            let reference = package.application_ref();
                            let label = if package.manifest().display_name.trim().is_empty() {
                                reference.id.clone()
                            } else {
                                package.manifest().display_name.clone()
                            };
                            candidates.push(BindingCandidate::Package {
                                presentation: package.manifest().presentation(),
                                key: format!(
                                    "package:{}:{}:{name}",
                                    reference.id, reference.revision
                                ),
                                label: if entry.exports.len() == 1 {
                                    label
                                } else {
                                    format!("{label} / {name}")
                                },
                                package: reference,
                                export: name.clone(),
                            });
                        }
                    }
                }
            }
        }
        candidates.sort_by(|a, b| candidate_key(a).cmp(candidate_key(b)));
        if let Some(after) = request.after {
            let index = candidates
                .iter()
                .position(|c| candidate_key(c) == after)
                .ok_or("binding choice cursor unavailable")?;
            candidates.drain(..=index);
        }
        let next = (candidates.len() > 8).then(|| candidate_key(&candidates[7]).to_owned());
        candidates.truncate(8);
        serde_json::to_value(BindingCandidatesPage {
            source: loaded.source().reference.clone(),
            configuration,
            current,
            candidates,
            next,
        })
        .map_err(|e| e.to_string())
    }
    pub(super) async fn package_settings(&self, input: Value) -> Result<Value> {
        let request: PackageSettingsRead =
            serde_json::from_value(input).map_err(|e| e.to_string())?;
        settings::check_path(&request.path, true)?;
        let _read = self.writes.lock().await;
        let loaded = self.source_at(Some(request.source.clone())).await?;
        let declaration = declaration(loaded.packages(), &request.package)?;
        let root_schema = package_schema(declaration, request.use_package)?;
        let mut configuration = defaults(&root_schema);
        if !request.changes.is_empty() {
            settings::apply(&mut configuration, &request.changes)?;
        }
        let (schema, value) = settings::at(&root_schema, &configuration, &request.path)?;
        let mut fields = settings::fields(schema, &root_schema, value)?;
        if let Some(after) = request.after {
            let index = fields
                .iter()
                .position(|f| f.key == after)
                .ok_or("settings cursor unavailable")?;
            fields.drain(..=index);
        }
        let (fields, next) = settings::settings_page(fields)?;
        let imports = match request.use_package {
            PackageUse::Host => Some(&declaration.host.as_ref().unwrap().imports),
            PackageUse::Ui => None,
            PackageUse::Composition => Some(&declaration.composition.as_ref().unwrap().imports),
        }
        .into_iter()
        .flatten()
        .map(|(name, import)| ManagedImport {
            name: name.clone(),
            contract: import.contract.name.clone(),
            cardinality: import.cardinality,
        })
        .collect();
        serde_json::to_value(PackageSettingsPage {
            source: request.source,
            package: request.package,
            path: request.path,
            fields,
            next,
            imports,
        })
        .map_err(|e| e.to_string())
    }
    pub(super) async fn edit_composition(&self, input: Value) -> Result<Value> {
        let request: CompositionEdit = serde_json::from_value(input).map_err(|e| e.to_string())?;
        let _write = self.writes.lock().await;
        let metadata = self.metadata().await?;
        if request.expected_revision != metadata.source.reference.revision {
            return conflict(metadata.source.reference.revision);
        }
        let loaded = self.source_at(Some(metadata.source.reference)).await?;
        let (mut source, packages, _, _) = loaded.into_parts();
        let applied = (|| -> Result<()> {
            if request.edits.is_empty() {
                return Err("no composition changes".into());
            }
            for change in request.edits {
                match change {
                    CompositionChange::Insert {
                        name,
                        package,
                        use_package,
                        settings: changes,
                        bindings,
                    } => {
                        if source.input.instances.contains_key(&name) {
                            return Err("instance name already exists".into());
                        }
                        let declaration = declaration(&packages, &package)?;
                        let schema = package_schema(declaration, use_package)?;
                        let mut configuration = defaults(&schema);
                        if !changes.is_empty() {
                            settings::apply(&mut configuration, &changes)?;
                        }
                        let values = configuration
                            .as_object()
                            .ok_or("instance configuration must be an object")?
                            .iter()
                            .map(|(k, v)| (k.clone(), v.clone()))
                            .collect();
                        let values = Values {
                            values,
                            ..Default::default()
                        };
                        let (configuration, parameters) = match use_package {
                            PackageUse::Composition => (Values::default(), values),
                            PackageUse::Host | PackageUse::Ui => (values, Values::default()),
                        };
                        source.input.instances.insert(
                            name,
                            Node {
                                key: uuid::Uuid::new_v4(),
                                package: package.into(),
                                use_package,
                                configuration,
                                parameters,
                                bindings,
                                disabled: false,
                                overrides: vec![],
                            },
                        );
                    }
                    CompositionChange::Update {
                        name,
                        configuration,
                        bindings,
                    } => {
                        let node = source
                            .input
                            .instances
                            .get_mut(&name)
                            .ok_or("instance root unavailable")?;
                        let values = match node.use_package {
                            PackageUse::Composition => &mut node.parameters,
                            PackageUse::Host | PackageUse::Ui => &mut node.configuration,
                        };
                        for (field, value) in configuration {
                            values.parameters.remove(&field);
                            values.values.insert(field, value);
                        }
                        node.bindings.extend(bindings);
                    }
                    CompositionChange::Remove { name } => {
                        source
                            .input
                            .instances
                            .remove(&name)
                            .ok_or("instance root unavailable")?;
                    }
                }
            }
            Ok(())
        })();
        if let Err(error) = applied {
            return rejected_diagnostic(ManagementRejection::InvalidSource, error);
        }
        self.commit(
            request.expected_revision,
            source.input,
            source.remote_exports,
            packages,
            |source| source,
        )
        .await
    }
}

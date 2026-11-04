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

mod root;
pub use root::RootComposition;

use std::collections::{BTreeMap, BTreeSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::{
    Error,
    contract::Import,
    package::{PackageRef, PackageSelection},
};

/// Hierarchical, stable source keys. Display aliases never become data identities.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
pub struct InstanceId(pub Vec<Uuid>);

impl InstanceId {
    pub fn validate(&self) -> Result<(), Error> {
        if self.0.is_empty() || self.0.iter().any(Uuid::is_nil) {
            return Err(Error::Composition("invalid instance identity".into()));
        }
        Ok(())
    }
}

/// Durable deployment input. Plans are derived and never persisted as overrides.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "CompositionInput")]
pub struct Input {
    /// Optional immutable root composition. Its children remain deployment roots,
    /// so selecting a baseline does not prepend a namespace to instance identities.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<RootComposition>,
    pub instances: BTreeMap<String, Node>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui: Option<UiTarget>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UiTarget {
    pub path: Vec<String>,
    pub id: String,
}

impl UiTarget {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        validate_path(&self.path)?;
        crate::name(&self.id)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "CompositionNode")]
pub struct Node {
    pub key: Uuid,
    pub package: PackageSelection,
    pub use_package: PackageUse,
    #[serde(default)]
    pub configuration: Configuration,
    #[serde(default)]
    pub parameters: Configuration,
    #[serde(default)]
    pub bindings: BTreeMap<String, Vec<Target>>,
    #[serde(default)]
    pub disabled: bool,
    #[serde(default)]
    pub overrides: Vec<Override>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PackageUse {
    Host,
    Ui,
    Composition,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Configuration {
    #[serde(default)]
    pub values: BTreeMap<String, Value>,
    /// Configuration field -> parameter name of the containing template.
    #[serde(default)]
    pub parameters: BTreeMap<String, String>,
}

impl Configuration {
    pub(crate) fn resolve(
        &self,
        parameters: &BTreeMap<String, Value>,
    ) -> Result<BTreeMap<String, Value>, Error> {
        let mut values = self.values.clone();
        for (field, parameter) in &self.parameters {
            if values.contains_key(field) {
                return Err(Error::Composition(format!(
                    "configuration field has two sources: {field}"
                )));
            }
            values.insert(
                field.clone(),
                parameters
                    .get(parameter)
                    .ok_or_else(|| {
                        Error::Composition(format!("missing template parameter: {parameter}"))
                    })?
                    .clone(),
            );
        }
        Ok(values)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Template {
    /// Default UI selection when this template is used at deployment scope.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui: Option<UiTarget>,
    #[serde(default)]
    pub parameters: BTreeMap<String, Parameter>,
    #[serde(default)]
    pub imports: BTreeMap<String, Import>,
    #[serde(default)]
    pub exports: BTreeMap<String, Target>,
    pub children: BTreeMap<String, Node>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Parameter {
    pub schema: crate::Schema,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub default: Option<Value>,
}

fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

/// An override belongs to its containing structural instance. Missing paths fail;
/// removal/upgrade never guesses how to discard independent user intent.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Override {
    pub path: Vec<String>,
    /// A persistent deletion, distinct from disabling an instance.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub remove: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package: Option<PackageRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub use_package: Option<PackageUse>,
    #[serde(default)]
    pub parameters: BTreeMap<String, Value>,
    #[serde(default)]
    pub configuration: BTreeMap<String, Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub configuration_fields: Vec<ConfigurationField>,
    #[serde(default)]
    pub bindings: BTreeMap<String, Vec<Target>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disabled: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Target {
    Instance {
        path: Vec<String>,
        export: String,
    },
    Import {
        name: String,
    },
    Remote {
        deployment: String,
        instance: InstanceId,
        export: String,
    },
}

/// An exact object-field edit. Missing value deletes the field; JSON null is a value.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ConfigurationField {
    pub path: Vec<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub value: Option<Value>,
}

impl ConfigurationField {
    fn insert(fields: &mut Vec<Self>, field: Self) -> Result<(), Error> {
        if let Some(parent) = fields
            .iter_mut()
            .find(|old| field.path.starts_with(&old.path))
        {
            if field.path == parent.path {
                parent.value = field.value;
                return Ok(());
            }
            if parent.value.is_none() && field.value.is_none() {
                return Ok(());
            }
            let value = parent
                .value
                .get_or_insert_with(|| Value::Object(Default::default()));
            let relative = &field.path[parent.path.len()..];
            let mut configuration = Configuration {
                values: BTreeMap::from([("value".into(), value.clone())]),
                ..Configuration::default()
            };
            let mut path = vec!["value".into()];
            path.extend_from_slice(relative);
            Self {
                path,
                value: field.value,
            }
            .apply(&mut configuration)?;
            *value = configuration.values.remove("value").unwrap();
            return Ok(());
        }
        fields.retain(|old| !old.path.starts_with(&field.path));
        fields.push(field);
        Ok(())
    }

    fn apply(&self, configuration: &mut Configuration) -> Result<(), Error> {
        let (root, path) = self
            .path
            .split_first()
            .ok_or_else(|| Error::Composition("empty configuration field path".into()))?;
        if path.is_empty() {
            configuration.parameters.remove(root);
            match &self.value {
                Some(value) => {
                    configuration.values.insert(root.clone(), value.clone());
                }
                None => {
                    configuration.values.remove(root);
                }
            }
            return Ok(());
        }
        let create = self.value.is_some();
        let current = if create {
            Some(
                configuration
                    .values
                    .entry(root.clone())
                    .or_insert_with(|| Value::Object(Default::default())),
            )
        } else {
            configuration.values.get_mut(root)
        };
        let Some(mut current) = current else {
            return Ok(());
        };
        for field in &path[..path.len() - 1] {
            let object = current.as_object_mut().ok_or_else(|| {
                Error::Composition(format!(
                    "configuration field parent is not an object: {:?}",
                    self.path
                ))
            })?;
            let next = if create {
                Some(
                    object
                        .entry(field.clone())
                        .or_insert_with(|| Value::Object(Default::default())),
                )
            } else {
                object.get_mut(field)
            };
            let Some(next) = next else {
                return Ok(());
            };
            current = next;
        }
        let object = current.as_object_mut().ok_or_else(|| {
            Error::Composition(format!(
                "configuration field parent is not an object: {:?}",
                self.path
            ))
        })?;
        match &self.value {
            Some(value) => {
                object.insert(path.last().unwrap().clone(), value.clone());
            }
            None => {
                object.remove(path.last().unwrap());
            }
        }
        Ok(())
    }
}

impl Override {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        validate_path(&self.path)?;
        if self.remove
            && (self.package.is_some()
                || self.use_package.is_some()
                || !self.parameters.is_empty()
                || !self.configuration.is_empty()
                || !self.configuration_fields.is_empty()
                || !self.bindings.is_empty()
                || self.disabled.is_some())
        {
            return Err(Error::Composition(
                "a deletion cannot contain instance edits".into(),
            ));
        }
        let mut paths = BTreeSet::new();
        for field in &self.configuration_fields {
            if field.path.is_empty() || !paths.insert(&field.path) {
                return Err(Error::Composition(
                    "empty or duplicate configuration field path".into(),
                ));
            }
            if self
                .configuration_fields
                .iter()
                .any(|other| other.path != field.path && other.path.starts_with(&field.path))
            {
                return Err(Error::Composition(
                    "overlapping configuration field edits".into(),
                ));
            }
        }
        if let Some(package) = &self.package {
            package.validate()?;
        }
        for (name, targets) in &self.bindings {
            crate::name(name)?;
            for target in targets {
                target.validate()?;
            }
        }
        Ok(())
    }

    fn merge(&mut self, patch: Self) -> Result<(), Error> {
        for key in patch.configuration.keys() {
            self.configuration_fields
                .retain(|field| field.path.first() != Some(key));
        }
        for field in patch.configuration_fields {
            ConfigurationField::insert(&mut self.configuration_fields, field)?;
        }
        self.configuration.extend(patch.configuration);
        self.bindings.extend(patch.bindings);
        self.parameters.extend(patch.parameters);
        if patch.package.is_some() {
            self.package = patch.package;
        }
        if patch.use_package.is_some() {
            self.use_package = patch.use_package;
        }
        if patch.disabled.is_some() {
            self.disabled = patch.disabled;
        }
        self.remove |= patch.remove;
        Ok(())
    }
}

impl Node {
    pub(crate) fn apply_overrides(
        &mut self,
        alias: &str,
        overrides: &[Override],
        parameters: &BTreeMap<String, Value>,
    ) -> Result<(), Error> {
        self.configuration = Configuration {
            values: self.configuration.resolve(parameters)?,
            ..Configuration::default()
        };
        let mut children: BTreeMap<_, _> = self
            .overrides
            .iter()
            .map(|patch| (patch.path.clone(), patch.clone()))
            .collect();
        for patch in overrides.iter().filter(|patch| patch.path[0] == alias) {
            patch.validate()?;
            if patch.path.len() == 1 {
                if patch.remove {
                    return Err(Error::Composition("cannot edit a removed instance".into()));
                }
                if let Some(package) = &patch.package {
                    self.package = package.clone().into();
                }
                if let Some(use_package) = patch.use_package {
                    self.use_package = use_package;
                }
                for (field, value) in &patch.parameters {
                    self.parameters.parameters.remove(field);
                    self.parameters.values.insert(field.clone(), value.clone());
                }
                for (field, value) in &patch.configuration {
                    self.configuration.parameters.remove(field);
                    self.configuration
                        .values
                        .insert(field.clone(), value.clone());
                }
                for field in &patch.configuration_fields {
                    field.apply(&mut self.configuration)?;
                }
                self.bindings.extend(patch.bindings.clone());
                if let Some(disabled) = patch.disabled {
                    self.disabled = disabled;
                }
            } else {
                let mut relative = patch.clone();
                relative.path.remove(0);
                if relative.remove {
                    children.insert(relative.path.clone(), relative);
                } else {
                    children
                        .entry(relative.path.clone())
                        .or_insert_with(|| Override {
                            path: relative.path.clone(),
                            ..Override::default()
                        })
                        .merge(relative)?;
                }
            }
        }
        self.overrides = children.into_values().collect();
        Ok(())
    }
}

impl Target {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        match self {
            Self::Instance { path, export } => {
                validate_path(path)?;
                crate::name(export)?;
            }
            Self::Import { name } => crate::name(name)?,
            Self::Remote {
                deployment,
                instance,
                export,
            } => {
                crate::name(deployment)?;
                instance.validate()?;
                crate::name(export)?;
            }
        }
        Ok(())
    }
}

pub(crate) fn validate_path(path: &[String]) -> Result<(), Error> {
    if path.is_empty() {
        return Err(Error::Composition("invalid relative instance path".into()));
    }
    for part in path {
        crate::name(part)?;
    }
    Ok(())
}

impl Node {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        if self.key.is_nil() {
            return Err(Error::Composition(
                "instance source key must be nonzero".into(),
            ));
        }
        if let PackageSelection::Pinned { package } = &self.package {
            package.validate()?;
        }
        for (name, targets) in &self.bindings {
            crate::name(name)?;
            for target in targets {
                target.validate()?;
            }
        }
        validate_overrides(&self.overrides)?;
        Ok(())
    }
}

impl Template {
    pub(crate) fn resolve_parameters(
        &self,
        mut supplied: BTreeMap<String, Value>,
    ) -> Result<BTreeMap<String, Value>, Error> {
        for name in supplied.keys() {
            if !self.parameters.contains_key(name) {
                return Err(Error::Composition(format!(
                    "undeclared template parameter: {name}"
                )));
            }
        }
        for (name, parameter) in &self.parameters {
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
        Ok(supplied)
    }

    pub fn validate(&self) -> Result<(), Error> {
        if let Some(ui) = &self.ui {
            ui.validate()?;
        }
        crate::package::validate_imports(&self.imports)?;
        for (name, parameter) in &self.parameters {
            crate::name(name)?;
            crate::schema(&parameter.schema)?;
            if let Some(default) = &parameter.default {
                crate::validate_value(&parameter.schema, default)?;
            }
        }
        for (name, target) in &self.exports {
            crate::name(name)?;
            target.validate()?;
        }
        validate_nodes(&self.children)
    }
}

pub(crate) fn validate_nodes(nodes: &BTreeMap<String, Node>) -> Result<(), Error> {
    let mut keys = BTreeSet::new();
    for (name, node) in nodes {
        crate::name(name)?;
        node.validate()?;
        if !keys.insert(node.key) {
            return Err(Error::Composition(
                "sibling instances share a source identity".into(),
            ));
        }
    }
    Ok(())
}

pub(crate) fn validate_overrides(overrides: &[Override]) -> Result<(), Error> {
    let mut paths = BTreeSet::new();
    for patch in overrides {
        patch.validate()?;
        if !paths.insert(&patch.path) {
            return Err(Error::Composition("duplicate override path".into()));
        }
        if patch.remove
            && overrides
                .iter()
                .any(|other| other.path != patch.path && other.path.starts_with(&patch.path))
        {
            return Err(Error::Composition(
                "deletion conflicts with a descendant override".into(),
            ));
        }
    }
    Ok(())
}

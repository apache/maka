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

fn present<'de, D>(deserializer: D) -> Result<Option<Value>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Value::deserialize(deserializer).map(Some)
}

/// An override belongs to its containing structural instance. Missing paths fail;
/// removal/upgrade never guesses how to discard independent user intent.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Override {
    pub path: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package: Option<PackageRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub use_package: Option<PackageUse>,
    #[serde(default)]
    pub parameters: BTreeMap<String, Value>,
    #[serde(default)]
    pub configuration: BTreeMap<String, Value>,
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
        let mut paths = BTreeSet::new();
        for patch in &self.overrides {
            validate_path(&patch.path)?;
            if let Some(package) = &patch.package {
                package.validate()?;
            }
            if !paths.insert(&patch.path) {
                return Err(Error::Composition("duplicate override path".into()));
            }
            for (name, targets) in &patch.bindings {
                crate::name(name)?;
                for target in targets {
                    target.validate()?;
                }
            }
        }
        Ok(())
    }
}

impl Template {
    pub fn validate(&self) -> Result<(), Error> {
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
